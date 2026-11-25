import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { getLierdaHardwareProfile, parseLierdaPackage } from '../src/lierda-package.mjs';
import { lierdaBoards } from '../src/lierda-boards.mjs';

const repository = 'tangeai/xiaotai-lierda';
const releaseApi = 'https://api.github.com/repos/' + repository + '/releases';
const tagPattern = /^(lite|pro)-v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const packageName = /^[a-z0-9][a-z0-9._+-]{0,249}\.binpkg$/i;
const checksumName = 'SHA256SUMS.txt';

const hash = (data) => createHash('sha256').update(data).digest('hex');

async function request(fetcher, url, { api = false, decode }) {
  const headers = { Accept: api ? 'application/vnd.github+json' : 'application/octet-stream' };
  if (api && process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(api ? 30000 : 120000) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`GitHub 返回 HTTP ${response.status}（${url}）`);
        error.status = response.status;
        throw error;
      }
      return await decode(response);
    } catch (error) {
      const retryable = error instanceof TypeError || error.name === 'TimeoutError'
        || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) throw error;
      await wait(attempt * 1000);
    }
  }
}

async function listReleases(fetcher, includePrerelease) {
  const byProduct = { lite: [], pro: [] };
  for (let page = 1; ; page += 1) {
    const { data, next } = await request(fetcher, `${releaseApi}?per_page=100&page=${page}`, {
      api: true,
      async decode(response) {
        return { data: await response.json(), next: response.headers.get('link')?.includes('rel="next"') };
      },
    });
    if (!Array.isArray(data)) throw new Error('GitHub Release 列表格式无效。');
    for (const release of data) {
      if (release?.draft || typeof release?.tag_name !== 'string') continue;
      const tag = tagPattern.exec(release.tag_name);
      if (!tag) continue;
      const product = tag[1];
      if (release.prerelease && (product === 'pro' || !includePrerelease)) continue;
      byProduct[product].push({ release, version: tag.slice(2).map(Number) });
    }
    if (!next) break;
  }
  for (const releases of Object.values(byProduct)) {
    releases.sort((a, b) => b.version[0] - a.version[0]
      || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  }
  return byProduct;
}

function checkedAsset(release, asset, maxSize) {
  const url = new URL(asset.browser_download_url);
  const expectedPath = `/${repository}/releases/download/${release.tag_name}/${asset.name}`;
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== expectedPath) {
    throw new Error(`${release.tag_name} 的附件地址不匹配。`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxSize) {
    throw new Error(`${asset.name} 的附件大小不在允许范围内。`);
  }
  const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1].toLowerCase();
  if (asset.digest && !digest) throw new Error(`${asset.name} 的 GitHub 附件摘要格式无效。`);
  return { url: url.href, size: asset.size, digest };
}

async function downloadAsset(fetcher, asset) {
  return request(fetcher, asset.url, {
    async decode(response) {
      if (!response.body) throw new Error('GitHub 附件下载没有响应内容。');
      const reader = response.body.getReader();
      const data = Buffer.alloc(asset.size);
      let offset = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.length > data.length - offset) throw new Error('下载内容超过附件大小。');
          data.set(value, offset);
          offset += value.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (offset !== data.length) throw new Error('下载内容与附件大小不一致。');
      if (asset.digest && hash(data) !== asset.digest) throw new Error('GitHub 附件 SHA-256 校验失败。');
      return data;
    },
  });
}

function releaseChecksum(data, name) {
  const matches = data.toString('utf8').split(/\r?\n/u)
    .map((line) => /^([a-f0-9]{64})[ \t]+\*?([^\s]+)$/iu.exec(line.trim()))
    .filter((fields) => fields?.[2] === name);
  if (matches.length !== 1)
    throw new Error(`${checksumName} 必须包含一条与 ${name} 相符的 SHA-256。`);
  return matches[0][1].toLowerCase();
}

async function cachedBytes(path, size) {
  const info = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.size !== size) throw new Error(`已发布附件大小或类型不匹配：${path}`);
  return readFile(path);
}

async function importProductReleases(board, releases, output, fetcher, writeLegacyLiteCatalog = false) {
  const { model, modem, modempkg } = board;
  const product = board.slug.slice('lierda-'.length);
  const maxPackageSize = getLierdaHardwareProfile(model).size + 0x10000;
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, '.' + product + '-'));
  const catalog = { releases: [] };
  const staged = [];
  const seen = new Set();
  try {
    for (const { release, version } of releases) {
      if (seen.has(release.tag_name)) throw new Error(`重复的发布标签：${release.tag_name}`);
      seen.add(release.tag_name);
      const packages = release.assets?.filter(({ name }) => packageName.test(name));
      const checksums = release.assets?.filter(({ name }) => name === checksumName);
      if (packages?.length !== 1 || checksums?.length !== 1) {
        throw new Error(`${release.tag_name} 需要一个 BINPKG 附件和一个 ${checksumName}。`);
      }
      const [pkg] = packages;
      const image = checkedAsset(release, pkg, maxPackageSize);
      const checksumAsset = checkedAsset(release, checksums[0], 65536);
      const sha256 = releaseChecksum(await downloadAsset(fetcher, checksumAsset), pkg.name);
      if (image.digest && sha256 !== image.digest) {
        throw new Error(`${release.tag_name} 的 SHA-256 校验记录不一致。`);
      }
      const filename = `${release.tag_name}-${sha256}.binpkg`;
      const destination = join(output, filename);
      const existing = await cachedBytes(destination, image.size);
      const bytes = existing ?? await downloadAsset(fetcher, image);
      await parseLierdaPackage(bytes, { model, stage: 'app', filename: pkg.name, sha256 });
      if (!existing) {
        const temporary = join(stage, filename);
        await writeFile(temporary, bytes, { flag: 'wx' });
        staged.push({ temporary, destination, sha256, size: bytes.length });
      }
      catalog.releases.push({
        modem, modempkg,
        version: version.join('.'), filename, source_filename: pkg.name,
        byte_length: bytes.length, sha256,
        ...(release.prerelease ? { prerelease: true } : {}),
        recommended: false,
      });
    }
    for (const { temporary, destination, sha256, size } of staged) {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await cachedBytes(destination, size);
        if (!existing || hash(existing) !== sha256) throw error;
      }
    }
    const recommended = catalog.releases.find((item) => !item.prerelease) ?? catalog.releases[0];
    if (recommended) recommended.recommended = true;
    if (writeLegacyLiteCatalog) {
      const manifest = join(stage, 'lite.json');
      await writeFile(manifest, JSON.stringify(catalog, null, 2) + '\n');
      await rename(manifest, join(output, 'lite.json'));
    }
    return catalog;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function importLierdaLiteCatalog(output, fetcher = fetch) {
  const { lite } = await listReleases(fetcher, false);
  if (lite.length === 0) return null;
  const board = lierdaBoards.find(({ slug }) => slug === 'lierda-lite');
  return importProductReleases(board, lite, output, fetcher, true);
}

export async function collectLierdaBoards(firmwareDir, { includePrerelease = false, previousBoards = [], fetcher = fetch } = {}) {
  let byProduct;
  let failed = false;
  let synced = false;
  try {
    byProduct = await listReleases(fetcher, includePrerelease);
  } catch (error) {
    failed = true;
    console.error('[ERROR] 无法同步利尔达 Release 列表：' + error.message);
  }
  const boards = [];
  for (const board of lierdaBoards) {
    const { slug, chip, name, flashBytes, modem, modempkg } = board;
    const product = slug.slice('lierda-'.length);
    const entry = { slug, model: name, chip, flash_bytes: flashBytes, modem, modempkg, releases: [] };
    if (byProduct) {
      try {
        const catalog = await importProductReleases(board, byProduct[product], firmwareDir, fetcher);
        entry.releases = catalog.releases.map(({ version, filename, source_filename, byte_length, sha256, recommended, prerelease }) => ({
          version, status: 'published', bin_url: './firmware/' + filename,
          source_filename, byte_length, sha256, recommended,
          ...(prerelease ? { prerelease: true } : {}),
        }));
        boards.push(entry);
        synced = true;
        continue;
      } catch (error) {
        failed = true;
        console.error('[ERROR] 无法同步 ' + name + '：' + error.message);
      }
    }
    const previous = previousBoards.find((item) => item.slug === slug);
    if (previous) boards.push(previous);
  }
  return { boards, failed, synced };
}
