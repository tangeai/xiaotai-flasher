import { flashProtocol, localPlatforms, platformDefinitions } from '../src/catalog-platforms.mjs';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { canonicalBoardSlug } from '../src/catalog.mjs';
import { lierdaBoardForLink } from '../src/lierda-boards.mjs';
import { chips } from '../src/chips.mjs';
import { collectLierdaBoards } from './import-lierda.mjs';
import curatedCatalog from '../boards.json' with { type: 'json' };

const apiRoot = 'https://api.github.com/repos/';
const espRepo = 'tangeai/xiaotai-esp32';
const archiveRepo = 'tangeai/xiaotai';
const maxImageSize = 128 * 1024 * 1024;
const downloadIdleMs = 180000;
const requestAttempts = 3;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digestPattern = /^[0-9a-f]{64}$/i;

const productSlugs = {
  'xiaotai-szpi-s3': 'lckfb-esp32s3',
  'xiaotai-cores3-lite': 'm5stack-cores3-lite',
};
const legacySlugs = {
  'esp32-s3': 'lckfb-esp32s3',
  'esp32-p4': 'waveshare-p4-rev3',
  'm5stack-cores3-lite': 'm5stack-cores3-lite',
  'mz28-ai': 'mz28-ai-ppd-v12',
};

async function request(
  url,
  { api = false, signal = AbortSignal.timeout(30000) } = {},
) {
  const headers = api ? { Accept: 'application/vnd.github+json' } : {};
  if (api && process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`GitHub 返回 HTTP ${response.status} (${url})`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function retryable(error) {
  return (
    error instanceof TypeError ||
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    error.status === 429 ||
    error.status >= 500
  );
}

function errorDetail(error) {
  const cause = error.cause?.code || error.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}

async function readMetadata(url) {
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const response = await request(url, { api: true });
      return { data: await response.json(), headers: response.headers };
    } catch (error) {
      const message = `${url}：${errorDetail(error)}`;
      if (!retryable(error) || attempt === requestAttempts) {
        throw new Error(`读取 GitHub 发布信息失败：${message}`, {
          cause: error,
        });
      }
      console.warn(`读取 GitHub 发布信息中断，将重试：${message}`);
      await wait(1000 * attempt);
    }
  }
}

const api = (path) => readMetadata(apiRoot + path);

async function listReleases(repository, includePrerelease) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const { data, headers } = await api(
      `${repository}/releases?per_page=100&page=${page}`,
    );
    releases.push(...data);
    if (!headers.get('link')?.includes('rel="next"')) break;
  }
  return releases
    .filter(
      (release) => !release.draft && (includePrerelease || !release.prerelease),
    )
    .sort(
      (left, right) =>
        Date.parse(right.published_at) - Date.parse(left.published_at),
    );
}

function normalizeChip(target) {
  const chip = String(target ?? '').toUpperCase().replace(/^ESP32-?([A-Z]+[0-9]+)$/, 'ESP32-$1');
  return chips.includes(chip) ? chip : null;
}

function assetDetails(release, filename, expected = {}) {
  const asset = release.assets.find(
    (candidate) =>
      candidate.name === filename && candidate.state === 'uploaded',
  );
  if (!asset)
    throw new Error(`${release.tag_name} 缺少 Release 附件 ${filename}`);
  const digest = asset.digest?.startsWith('sha256:')
    ? asset.digest.slice(7).toLowerCase()
    : '';
  const checksum = expected.sha256?.toLowerCase() || digest;
  if (
    !digestPattern.test(checksum) ||
    (digest && digest !== checksum) ||
    (expected.bytes !== undefined && asset.size !== expected.bytes)
  ) {
    throw new Error(
      `${release.tag_name} 的 ${filename} 缺少 SHA‑256 或清单与 Release 附件不一致`,
    );
  }
  const url = new URL(asset.browser_download_url);
  if (
    url.origin !== 'https://github.com' ||
    !url.pathname.startsWith('/tangeai/')
  ) {
    throw new Error(`Release 附件链接不符合预期：${filename}`);
  }
  return { filename, url: url.href, sha256: checksum, bytes: asset.size };
}

function releaseEntry(repository, release, board, image) {
  if (
    typeof board.slug !== 'string' ||
    !slugPattern.test(board.slug) ||
    !board.chip ||
    typeof board.model !== 'string' ||
    !board.model.trim()
  ) {
    throw new Error(`${release.tag_name} 的板卡标识、型号或芯片无效`);
  }
  if (
    !Number.isInteger(image.bytes) ||
    image.bytes < 1 ||
    image.bytes > maxImageSize
  ) {
    throw new Error(`${release.tag_name} 的完整镜像大小超出范围`);
  }
  return {
    ...board,
    image,
    prerelease: release.prerelease,
    version:
      release.tag_name +
      ' · ' +
      repository.split('/')[1] +
      (release.prerelease ? '（测试版）' : ''),
  };
}

function atZero(offset) {
  return /^(?:0x)?0+$/i.test(String(offset));
}

async function espEntries(release) {
  const manifestAsset = assetDetails(release, 'release-manifest.json');
  const bytes = await transferAsset(
    manifestAsset,
    `${release.tag_name}/${manifestAsset.filename}`,
  );
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.tag !== release.tag_name)
    throw new Error(`${release.tag_name} 发布清单 tag 不一致`);

  if (Array.isArray(manifest.products)) {
    const entries = [];
    for (const product of manifest.products) {
      const full = product.files?.full;
      const chip = normalizeChip(product.target);
      if (!chip || !full?.name || /-idf[0-9]/i.test(full.name)) continue;
      if (!atZero(full.offset) || !/-full-[0-9]+MB\.bin$/i.test(full.name)) {
        throw new Error(
          `${release.tag_name} 包含无法确认写入地址的完整镜像：${full.name}`,
        );
      }
      entries.push(
        releaseEntry(
          espRepo,
          release,
          {
            slug:
              productSlugs[product.name] ??
              product.name.replace(/^xiaotai-/, ''),
            model: product.model,
            chip,
          },
          assetDetails(release, full.name, full),
        ),
      );
    }
    return entries;
  }

  const { artifact, board, build, image, project } = manifest;
  if (
    !artifact?.filename ||
    !atZero(artifact.write_offset) ||
    !/-full-[0-9]+MB\.bin$/i.test(artifact.filename)
  ) {
    throw new Error(
      `${release.tag_name} 的旧版发布清单缺少起始地址为 0x0 的完整 BIN`,
    );
  }
  const chip = normalizeChip(image?.chip ?? build?.target);
  if (!chip) return [];
  const prefix = release.tag_name.split('-app-v')[0];
  const slug = legacySlugs[prefix] ?? project?.replace(/-xiaotai$/, '');
  return [
    releaseEntry(
      espRepo,
      release,
      {
        slug,
        model: board,
        chip,
      },
      assetDetails(release, artifact.filename, artifact),
    ),
  ];
}

async function archiveEntries(release, blobCache) {
  const tag = encodeURIComponent(release.tag_name);
  const { data: tree } = await api(
    `${archiveRepo}/git/trees/${tag}?recursive=1`,
  );
  if (tree.truncated)
    throw new Error(`${release.tag_name} 的仓库目录列表不完整`);
  const paths = tree.tree.filter(
    ({ type, path }) =>
      type === 'blob' && /^boards\/[^/]+\/[^/]+\/board\.json$/.test(path),
  );
  const boards = await Promise.all(
    paths.map(async ({ path, sha }) => {
      if (!blobCache.has(sha))
        blobCache.set(sha, api(`${archiveRepo}/git/blobs/${sha}`));
      const { data: blob } = await blobCache.get(sha);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
        throw new Error(`${release.tag_name} 的板卡定义无法读取：${path}`);
      }
      return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    }),
  );
  const entries = [];
  for (const board of boards) {
    const bk = board.target?.toLowerCase() === 'bk7258';
    const chip = bk ? 'BK7258' : normalizeChip(board.target);
    if (!chip) continue;
    const variants = board.variants ?? [];
    for (const variant of [
      { name: 'default', default: true },
      ...variants.filter((item) => item.name !== 'default'),
    ]) {
      const suffix = variant.name === 'default' ? '' : '_' + variant.name;
      const imageType = bk ? 'all-app' : 'merged';
      const filename = `${release.tag_name}_${board.id}${suffix}_${imageType}.bin`;
      if (!release.assets.some((asset) => asset.name === filename)) continue;
      const slug = canonicalBoardSlug(variant.default ? board.id : `${board.id}-${variant.name}`);
      entries.push(
        releaseEntry(
          archiveRepo,
          release,
          {
            slug,
            model: suffix && slug !== board.id ? `${board.model}（${variant.name}）` : board.model,
            chip,
            flashBytes: bk ? board.resources?.flash_bytes : undefined,
          },
          assetDetails(release, filename),
        ),
      );
    }
  }
  return entries;
}

function assemble(entries) {
  const boards = new Map();
  const images = new Map();
  for (const entry of entries) {
    if (!boards.has(entry.slug)) {
      const curated = curatedCatalog.boards.find(board => board.slug === entry.slug && board.chip === entry.chip);
      const platform = curated?.platform ?? flashProtocol(entry);
      boards.set(entry.slug, {
        platform,
        slug: entry.slug,
        model: entry.model,
        chip: entry.chip,
        ...(Number.isSafeInteger(entry.flashBytes) && entry.flashBytes > 0
          ? { flash_bytes: entry.flashBytes }
          : {}),
        releases: [],
      });
    }
    const board = boards.get(entry.slug);
    if (
      board.chip !== entry.chip ||
      board.releases.some((release) => release.version === entry.version)
    ) {
      throw new Error(`板卡 ${entry.slug} 的芯片或固件版本有冲突`);
    }
    const { filename, sha256 } = entry.image;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,249}\.bin$/.test(filename))
      throw new Error(`固件文件名不能用于下载路径：${filename}`);
    if (images.has(filename) && images.get(filename).sha256 !== sha256)
      throw new Error(`不同内容使用了相同的固件文件名：${filename}`);
    images.set(filename, entry.image);
    board.releases.push({
      version: entry.version,
      bin_url: `./firmware/${filename}`,
      sha256,
      status: 'published',
      prerelease: entry.prerelease,
    });
  }
  if (!boards.size) throw new Error('没有找到可烧录的已发布完整镜像。');

  const catalog = [...boards.values()].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
  for (const board of catalog) {
    const selected =
      board.releases.find((release) => !release.prerelease) ??
      board.releases[0];
    selected.recommended = true;
    for (const release of board.releases) delete release.prerelease;
  }
  return { catalog: { boards: catalog }, images: [...images.values()] };
}

async function validCachedImage(path, image) {
  const file = await stat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!file?.isFile() || file.size !== image.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === image.sha256;
}

async function downloadAsset(asset, temporary) {
  const controller = new AbortController();
  let host = new URL(asset.url).hostname;
  let bytes = 0;
  const idle = setTimeout(() => {
    const error = new Error(
      `连续 ${downloadIdleMs / 1000} 秒未收到数据（${host}，已收到 ${bytes}/${asset.bytes} 字节）`,
    );
    error.name = 'TimeoutError';
    controller.abort(error);
  }, downloadIdleMs);
  const chunks = [];
  const hash = createHash('sha256');
  const verify = new Transform({
    transform(chunk, _encoding, done) {
      idle.refresh();
      bytes += chunk.length;
      if (bytes > asset.bytes)
        return done(new Error('下载内容超出 Release 中的大小'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    const response = await request(asset.url, { signal: controller.signal });
    if (!response.body) throw new Error('下载没有响应内容');
    if (response.url) host = new URL(response.url).hostname;
    idle.refresh();
    const output = temporary
      ? createWriteStream(temporary, { flags: 'wx' })
      : new Writable({
          write(chunk, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        });
    await pipeline(Readable.fromWeb(response.body), verify, output, {
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idle);
  }
  if (bytes !== asset.bytes) {
    const error = new Error(`下载不完整，只收到 ${bytes}/${asset.bytes} 字节`);
    error.code = 'ERR_STREAM_PREMATURE_CLOSE';
    throw error;
  }
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error('下载内容 SHA‑256 校验失败');
  }
  if (!temporary) return Buffer.concat(chunks, bytes);
}

async function transferAsset(asset, label, temporary) {
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    console.log(`下载 ${label}（${attempt}/${requestAttempts}）`);
    try {
      return await downloadAsset(asset, temporary);
    } catch (error) {
      const detail = errorDetail(error);
      if (!retryable(error) || attempt === requestAttempts) {
        throw new Error(`${label} 下载失败：${detail}（${asset.url}）`, {
          cause: error,
        });
      }
      console.warn(`${label} 下载中断，将重试：${detail}`);
      if (temporary) await rm(temporary, { force: true });
      await wait(1000 * attempt);
    }
  }
}

async function mirrorImage(image, destination, temporary) {
  if (await validCachedImage(destination, image)) return;
  await transferAsset(image, image.filename, temporary);
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await validCachedImage(destination, image)))
      throw new Error(`已发布的同名文件内容不同：${image.filename}`);
  }
}

function sameBin(left, right) {
  return left.bin_url === right.bin_url && left.sha256 === right.sha256;
}

// Preserve local publication metadata for identical images. A BIN absent from
// GitHub may survive only if both the curated catalog and this deployment list it.
function preservePublishedBins(generated, previousBoards) {
  const boards = new Map(generated.map(board => [board.slug, board]));
  const published = [];
  for (const previous of previousBoards) {
    if (lierdaBoardForLink(previous.slug)) continue;
    const curated = curatedCatalog.boards.find(board =>
      board.slug === previous.slug && board.chip === previous.chip);
    const current = boards.get(previous.slug);
    if (current && current.chip !== previous.chip) continue;
    const releases = current?.releases ?? [];
    for (const old of previous.releases) {
      if (!old || !digestPattern.test(old.sha256) || typeof old.bin_url !== 'string' ||
          typeof old.version !== 'string' || !old.version || old.version.trim() !== old.version) continue;
      const fresh = releases.find(release => sameBin(release, old));
      const pinned = curated?.releases.find(release => sameBin(release, old));
      if (fresh) {
        if (old.status === 'offline' || old.status === 'draft') fresh.status = old.status;
        if (pinned?.status === 'offline' || pinned?.status === 'draft') fresh.status = pinned.status;
        // An upstream promotion or demotion must update the testing label.
        if (old.version.endsWith('（测试版）') === fresh.version.endsWith('（测试版）') &&
            !releases.some(release => release !== fresh && release.version === old.version)) {
          fresh.version = old.version;
        }
        if (typeof old.embedded_version === 'string' && old.embedded_version) fresh.embedded_version = old.embedded_version;
      } else if (old.status === 'published' && pinned?.status === 'published' &&
          !releases.some(release => release.version === old.version || release.bin_url === old.bin_url)) {
        releases.push({ ...old });
      }
    }
    if (!releases.length) continue;
    const board = current ?? { ...previous, releases };
    if (previous.platform) board.platform = previous.platform;
    if (curated?.model === previous.model) board.model = previous.model;
    const selected = releases.find(release => release.status === 'published' && release.recommended) ??
      releases.find(release => release.status === 'published');
    for (const release of releases) {
      if (release === selected) release.recommended = true;
      else delete release.recommended;
    }
    published.push(board);
    boards.delete(board.slug);
  }
  return [...published, ...boards.values()];
}

async function collectBinBoards(firmware, temporary, includePrerelease, previousBoards) {
  const [espReleases, archiveReleases] = await Promise.all([
    listReleases(espRepo, includePrerelease),
    listReleases(archiveRepo, includePrerelease),
  ]);
  const esp = [];
  for (const release of espReleases) esp.push(...(await espEntries(release)));
  const archived = [];
  const blobCache = new Map();
  for (const release of archiveReleases)
    archived.push(...await archiveEntries(release, blobCache));
  const { catalog, images } = assemble([...esp, ...archived]);
  console.log(`正在校验 ${images.length} 个完整 BIN…`);
  for (let start = 0; start < images.length; start += 3) {
    const batch = images.slice(start, start + 3).map((image) =>
      mirrorImage(image, join(firmware, image.filename), join(temporary, image.filename)),
    );
    const results = await Promise.allSettled(batch);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return preservePublishedBins(catalog.boards, previousBoards);
}

async function previousCatalog(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { boards: [] };
    throw error;
  }
  try {
    const catalog = JSON.parse(contents.replace(/^\uFEFF/u, ''));
    const { boards } = catalog;
    if (catalog.platforms !== undefined) platformDefinitions(catalog.platforms);
    if (!Array.isArray(boards) || !boards.every(board =>
      typeof board?.slug === 'string' && Array.isArray(board.releases)) ||
      new Set(boards.map(board => board.slug)).size !== boards.length) {
      throw new Error('缺少有效的板卡或版本列表。');
    }
    return catalog;
  } catch (error) {
    console.warn('[WARN] 已有 boards.json 无法解析，将在所有来源同步成功后重建：' + error.message);
    return null;
  }
}

export async function generateCatalog(output, includePrerelease = false) {
  const firmware = join(output, 'firmware');
  const path = join(output, 'boards.json');
  const previous = await previousCatalog(path);
  const previousBoards = previous?.boards ?? [];
  await mkdir(firmware, { recursive: true });
  const temporary = await mkdtemp(join(output, '.catalog-'));
  try {
    const [bin, lierda] = await Promise.allSettled([
      collectBinBoards(firmware, temporary, includePrerelease, previousBoards),
      collectLierdaBoards(firmware, { includePrerelease, previousBoards }),
    ]);
    const isLierda = ({ slug }) => Boolean(lierdaBoardForLink(slug));
    const binBoards = bin.status === 'fulfilled' ? bin.value : previousBoards.filter(board => !isLierda(board));
    const lierdaBoards = lierda.status === 'fulfilled' ? lierda.value.boards : previousBoards.filter(isLierda);
    if (bin.status === 'rejected') console.error('[ERROR] ESP32 / BK7258:', errorDetail(bin.reason));
    if (lierda.status === 'rejected') console.error('[ERROR] 利尔达:', errorDetail(lierda.reason));
    const failed = bin.status === 'rejected' || lierda.status === 'rejected' || lierda.value.failed;
    if (previous === null && failed) {
      console.error('[ERROR] 部分来源未能同步，已保留原 boards.json。');
      return { boards: [], failed: true };
    }
    const synced = bin.status === 'fulfilled' || (lierda.status === 'fulfilled' && lierda.value.synced);
    const boards = synced ? [...binBoards, ...lierdaBoards].map(({ platform_name, ...board }) => ({
      ...board, platform: board.platform ?? flashProtocol(board),
    })) : previousBoards;
    if (synced) {
      const names = platformDefinitions(previous?.platforms ?? []);
      for (const row of previousBoards) {
        if (row.platform && row.platform_name && !names.has(row.platform)) names.set(row.platform, row.platform_name);
      }
      const defaults = platformDefinitions(curatedCatalog.platforms);
      for (const { platform } of boards) {
        if (!names.has(platform)) names.set(platform, defaults.get(platform) ?? localPlatforms.get(platform));
      }
      const platforms = Array.from(names, ([platform, platform_name]) => ({ platform, platform_name }));
      platformDefinitions(platforms);
      const catalog = { platforms, boards };
      if (JSON.stringify(previous) !== JSON.stringify(catalog)) {
        const staged = join(temporary, 'boards.json');
        await writeFile(staged, JSON.stringify(catalog, null, 2) + '\n');
        await rename(staged, path);
      }
    }
    console.log(`固件目录共 ${boards.length} 款板卡、${boards.reduce((n, b) => n + b.releases.length, 0)} 个版本。`);
    return { boards, failed };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'output-dir': { type: 'string' },
      'include-prerelease': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      '用法：node scripts/generate-boards.mjs --output-dir 目录 [--include-prerelease]',
    );
  } else {
    if (!values['output-dir']?.trim())
      throw new Error('请通过 --output-dir 指定输出目录。');
    const { failed } = await generateCatalog(
      resolve(values['output-dir']),
      Boolean(values['include-prerelease']),
    );
    if (failed) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    console.error('[ERROR] ' + error.message);
    process.exitCode = 1;
  });
}
