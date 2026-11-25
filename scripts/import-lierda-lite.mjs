import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { getLierdaHardwareProfile, parseLierdaPackage } from '../src/lierda-package.mjs';

const repository = 'tangeai/xiaotai-lierda';
const releaseApi = 'https://api.github.com/repos/' + repository + '/releases';
const tagPattern = /^lite-v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const packageName = /^[a-z0-9][a-z0-9._+-]{0,249}\.binpkg$/i;
const checksumName = 'SHA256SUMS.txt';
const maxPackageSize = getLierdaHardwareProfile('lite').size + 0x10000;

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

async function listReleases(fetcher) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const { data, next } = await request(fetcher, `${releaseApi}?per_page=100&page=${page}`, {
      api: true,
      async decode(response) {
        return { data: await response.json(), next: response.headers.get('link')?.includes('rel="next"') };
      },
    });
    if (!Array.isArray(data)) throw new Error('GitHub Release 列表格式无效。');
    for (const release of data) {
      if (release?.draft || release?.prerelease || typeof release?.tag_name !== 'string') continue;
      const version = tagPattern.exec(release.tag_name)?.slice(1).map(Number);
      if (version) releases.push({ release, version });
    }
    if (!next) break;
  }
  return releases.sort((a, b) => b.version[0] - a.version[0]
    || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
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

export async function importLierdaLiteCatalog(output, fetcher = fetch) {
  const releases = await listReleases(fetcher);
  if (releases.length === 0) return null;
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, '.lite-'));
  const catalog = { releases: [] };
  const staged = [];
  const seen = new Set();
  try {
    for (const { release, version } of releases) {
      if (seen.has(release.tag_name)) throw new Error(`重复的 Lite 发布标签：${release.tag_name}`);
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
      await parseLierdaPackage(bytes, { model: 'lite', stage: 'app', filename: pkg.name, sha256 });
      if (!existing) {
        const temporary = join(stage, filename);
        await writeFile(temporary, bytes, { flag: 'wx' });
        staged.push({ temporary, destination, sha256, size: bytes.length });
      }
      catalog.releases.push({
        modem: 'NT26F6D0', modempkg: 'F6D_D',
        version: version.join('.'), filename, byte_length: bytes.length, sha256,
        recommended: catalog.releases.length === 0,
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
    const manifest = join(stage, 'lite.json');
    await writeFile(manifest, JSON.stringify(catalog, null, 2) + '\n');
    await rename(manifest, join(output, 'lite.json'));
    return catalog;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'output-dir': { type: 'string' } } });
    if (!values['output-dir']?.trim()) throw new Error('请通过 --output-dir 指定 Lite 固件目录。');
    const catalog = await importLierdaLiteCatalog(resolve(values['output-dir']));
    console.log(catalog ? `已更新 ${catalog.releases.length} 个 Lite 固件版本。` : '尚无 lite-v 发布，保留当前 Lite 固件目录。');
  } catch (error) {
    console.error('[ERROR] ' + error.message);
    process.exitCode = 1;
  }
}
