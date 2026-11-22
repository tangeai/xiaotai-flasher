import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';

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

async function readMetadata(url, format, api = false) {
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const response = await request(url, { api });
      return { data: await response[format](), headers: response.headers };
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

const api = (path) => readMetadata(apiRoot + path, 'json', true);

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
  const match = /^esp32(?:-?([a-z]+[0-9]+))?$/i.exec(target ?? '');
  return match
    ? match[1]
      ? 'ESP32-' + match[1].toUpperCase()
      : 'ESP32'
    : null;
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
      (release.prerelease ? '（体验版）' : ''),
  };
}

function atZero(offset) {
  return /^(?:0x)?0+$/i.test(String(offset));
}

async function espEntries(release) {
  const manifestAsset = assetDetails(release, 'release-manifest.json');
  const { data } = await readMetadata(manifestAsset.url, 'arrayBuffer');
  const bytes = Buffer.from(data);
  if (
    bytes.length !== manifestAsset.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== manifestAsset.sha256
  ) {
    throw new Error(`${release.tag_name} 发布清单校验失败`);
  }
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
  const prefix = release.tag_name.split('-app-v')[0];
  const slug = legacySlugs[prefix] ?? project?.replace(/-xiaotai$/, '');
  return [
    releaseEntry(
      espRepo,
      release,
      {
        slug,
        model: board,
        chip: normalizeChip(image?.chip ?? build?.target),
      },
      assetDetails(release, artifact.filename, artifact),
    ),
  ];
}

async function archiveEntries(release) {
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
      const { data: blob } = await api(`${archiveRepo}/git/blobs/${sha}`);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
        throw new Error(`${release.tag_name} 的板卡定义无法读取：${path}`);
      }
      return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    }),
  );
  const entries = [];
  for (const board of boards) {
    const chip = normalizeChip(board.target);
    if (!chip) continue;
    const variants = board.variants ?? [];
    for (const variant of [
      { name: 'default', default: true },
      ...variants.filter((item) => item.name !== 'default'),
    ]) {
      const suffix = variant.name === 'default' ? '' : '_' + variant.name;
      const filename = `${release.tag_name}_${board.id}${suffix}_merged.bin`;
      if (!release.assets.some((asset) => asset.name === filename)) continue;
      entries.push(
        releaseEntry(
          archiveRepo,
          release,
          {
            slug: variant.default ? board.id : `${board.id}-${variant.name}`,
            model: suffix ? `${board.model}（${variant.name}）` : board.model,
            chip,
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
      boards.set(entry.slug, {
        slug: entry.slug,
        model: entry.model,
        chip: entry.chip,
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
    const { sha256 } = entry.image;
    images.set(sha256, entry.image);
    board.releases.push({
      version: entry.version,
      bin_url: `./firmware/${sha256}.bin`,
      sha256,
      status: 'published',
      prerelease: entry.prerelease,
    });
  }
  if (!boards.size) throw new Error('没有找到可烧录的已发布完整 ESP32 镜像。');

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

async function downloadImage(image, temporary) {
  const controller = new AbortController();
  const idle = setTimeout(() => {
    const error = new Error(`连续 ${downloadIdleMs / 1000} 秒未收到固件数据`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, downloadIdleMs);
  let bytes = 0;
  const hash = createHash('sha256');
  const verify = new Transform({
    transform(chunk, _encoding, done) {
      idle.refresh();
      bytes += chunk.length;
      if (bytes > image.bytes)
        return done(new Error('下载固件超出 Release 中的大小'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    const response = await request(image.url, { signal: controller.signal });
    if (!response.body) throw new Error('固件下载没有响应内容');
    idle.refresh();
    await pipeline(
      Readable.fromWeb(response.body),
      verify,
      createWriteStream(temporary, { flags: 'wx' }),
      { signal: controller.signal },
    );
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idle);
  }
  if (bytes !== image.bytes) {
    const error = new Error(
      `固件下载不完整，只收到 ${bytes}/${image.bytes} 字节`,
    );
    error.code = 'ERR_STREAM_PREMATURE_CLOSE';
    throw error;
  }
  if (hash.digest('hex') !== image.sha256) {
    throw new Error('下载固件 SHA‑256 校验失败');
  }
}

async function mirrorImage(image, destination, temporary) {
  if (await validCachedImage(destination, image)) return;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    console.log(`下载 ${image.filename}（${attempt}/${requestAttempts}）`);
    try {
      await downloadImage(image, temporary);
    } catch (error) {
      const detail = errorDetail(error);
      if (!retryable(error) || attempt === requestAttempts) {
        throw new Error(
          `${image.filename} 下载失败：${detail}（${image.url}）`,
          { cause: error },
        );
      }
      console.warn(`${image.filename} 下载中断，将重试：${detail}`);
      await rm(temporary, { force: true });
      await wait(1000 * attempt);
      continue;
    }
    await rename(temporary, destination);
    return;
  }
}

async function generate(output, includePrerelease) {
  const [espReleases, archiveReleases] = await Promise.all([
    listReleases(espRepo, includePrerelease),
    listReleases(archiveRepo, includePrerelease),
  ]);
  const [esp, archived] = await Promise.all([
    Promise.all(espReleases.map(espEntries)),
    Promise.all(archiveReleases.map(archiveEntries)),
  ]);
  const { catalog, images } = assemble([...esp.flat(), ...archived.flat()]);
  console.log(`正在校验 ${images.length} 个完整 BIN…`);
  const firmware = join(output, 'firmware');
  await mkdir(firmware, { recursive: true });
  const temporary = await mkdtemp(join(output, '.catalog-'));
  try {
    for (let start = 0; start < images.length; start += 3) {
      const batch = images.slice(start, start + 3).map((image) => {
        const name = image.sha256 + '.bin';
        return mirrorImage(image, join(firmware, name), join(temporary, name));
      });
      const results = await Promise.allSettled(batch);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    const path = join(temporary, 'boards.json');
    await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
    await rename(path, join(output, 'boards.json'));
    console.log(
      `已生成 ${catalog.boards.length} 块板卡、${catalog.boards.reduce((count, board) => count + board.releases.length, 0)} 个版本，校验了 ${images.length} 个完整 BIN。`,
    );
    console.log(join(output, 'boards.json'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
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
    await generate(
      resolve(values['output-dir']),
      Boolean(values['include-prerelease']),
    );
  }
} catch (error) {
  console.error('[ERROR] ' + error.message);
  process.exitCode = 1;
}
