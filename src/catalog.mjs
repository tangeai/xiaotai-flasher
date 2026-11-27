import { LocalizedError, t, localizedMessage } from './i18n.mjs';
import { catalogPlatforms, flashProtocol, localPlatforms, platformDefinitions } from './catalog-platforms.mjs';
import { lierdaBoardForLink, lierdaPackageSizeLimit, lierdaReleaseFilename } from './lierda-boards.mjs';

const versionDigest = /^[a-f0-9]{64}$/i;
const boardSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const displayBoardSlug = slug => boardSlug.test(slug) || ['waveshare-p4-3.5', 'waveshare-p4-4.3'].includes(slug);
const releaseStates = new Set(['draft', 'published', 'offline']);
const packageName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,249}\.binpkg$/i;
const numericVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

export function canonicalBoardSlug(slug) {
  return slug === 'm5stack-cores3-lite-ili9342c' ? 'm5stack-cores3-lite' : slug;
}

function linkedURL(raw, base) {
  let url;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      url = new URL(raw, base);
    } catch {}
  }
  if (
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.origin === new URL(base).origin))
  ) {
    throw new LocalizedError('固件配置与 BIN 需使用同源链接或 HTTPS 直链。');
  }
  return url;
}

export function publishedCatalog(data, catalogURL) {
  const definitions = data?.platforms === undefined ? null : platformDefinitions(data.platforms);
  const boards = parseBoards(data, catalogURL, definitions);
  return { boards, platforms: definitions ?? catalogPlatforms(boards) };
}

export function publishedBoards(data, catalogURL) {
  return publishedCatalog(data, catalogURL).boards;
}

function parseBoards(data, catalogURL, definitions) {
  if (!Array.isArray(data?.boards))
    throw new LocalizedError('固件配置必须包含 boards 数组。');
  const slugs = new Set();
  const names = new Map();
  return data.boards.flatMap((board) => {
    const hardware = lierdaBoardForLink(board?.slug);
    const chip = typeof board?.chip === 'string' ? board.chip.trim().toUpperCase() : '';
    const legacy = !definitions && board?.platform === undefined && board?.platform_name === undefined;
    const platform = legacy ? flashProtocol({ slug: board?.slug, chip }) : board?.platform;
    if (legacy && !platform) return [];
    const name = definitions ? definitions.get(platform)
      : legacy ? localPlatforms.get(platform) : board?.platform_name;
    if (typeof platform !== 'string' || !boardSlug.test(platform) ||
        typeof name !== 'string' || !name.trim() || (names.has(platform) && names.get(platform) !== name.trim())) {
      throw new LocalizedError('平台标识或名称无效。');
    }
    names.set(platform, name.trim());
    const group = { platform, platform_name: name.trim() };
    if (hardware) {
      // An invalid BINPKG entry must never hide another platform's catalog.
      if (data.boards.filter(candidate => lierdaBoardForLink(candidate?.slug) === hardware).length !== 1) return [];
      const entry = publishedLierdaBoard(board, hardware, catalogURL);
      return entry ? [{ ...entry, ...group }] : [];
    }
    if (
      typeof board?.slug !== 'string' ||
      !displayBoardSlug(board.slug) ||
      slugs.has(board.slug) ||
      typeof board.model !== 'string' ||
      !board.model.trim() ||
      typeof board.chip !== 'string' ||
      !Array.isArray(board.releases)
    ) {
      throw new LocalizedError('板卡标识、型号、芯片或版本列表有误。');
    }
    slugs.add(board.slug);
    const flashBytes = board.flash_bytes;
    if (
      flashBytes !== undefined &&
      (!Number.isSafeInteger(flashBytes) || flashBytes <= 0)
    ) {
      throw new LocalizedError(localizedMessage('@0 的 Flash 容量配置无效。', board.model));
    }
    const versionNames = new Set();
    const versions = board.releases.flatMap((release) => {
      const version = typeof release?.version === 'string'
        ? release.version.replaceAll('体验版', '测试版')
        : '';
      if (
        typeof release?.version !== 'string' ||
        !release.version.trim() ||
        release.version !== release.version.trim() ||
        versionNames.has(version) ||
        !releaseStates.has(release.status)
      ) {
        throw new LocalizedError(localizedMessage('@0 的固件版本或发布状态有误。', board.model));
      }
      versionNames.add(version);
      if (release.status !== 'published') return [];
      const binURL = linkedURL(release.bin_url, catalogURL);
      if (
        typeof release.sha256 !== 'string' ||
        !versionDigest.test(release.sha256) ||
        (release.recommended !== undefined &&
          typeof release.recommended !== 'boolean')
      ) {
        throw new LocalizedError(
          localizedMessage('@0 @1 的 BIN 链接或 SHA‑256 有误。', board.model, release.version),
        );
      }
      return [{ ...release, version, bin_url: binURL.href }];
    });
    if (versions.filter((release) => release.recommended).length > 1) {
      throw new LocalizedError(localizedMessage('@0 只能有一个推荐版本。', board.model));
    }
    if (legacy && !versions.length) return [];
    return [
      {
        ...group,
        slug: board.slug,
        model: board.model.trim(),
        chip,
        flashBytes,
        versions,
      },
    ];
  });
}

function publishedLierdaBoard(board, hardware, catalogURL) {
  if (board.chip !== hardware.chip || board.flash_bytes !== hardware.flashBytes ||
      board.modem !== hardware.modem || board.modempkg !== hardware.modempkg ||
      typeof board.model !== 'string' || !board.model.trim() || !Array.isArray(board.releases)) return null;
  const versions = [];
  const seen = new Set();
  for (const release of board.releases) {
    if (!releaseStates.has(release?.status)) return null;
    if (release.status !== 'published') continue;
    if (release.prerelease !== undefined && typeof release.prerelease !== 'boolean') return null;
    if (hardware.model === 'pro-f9' && release.prerelease) continue;
    const { version, sha256, source_filename: filename, byte_length: bytes } = release;
    if (typeof version !== 'string' || !numericVersion.test(version) || seen.has(version) ||
        typeof sha256 !== 'string' || !versionDigest.test(sha256) ||
        typeof filename !== 'string' || !packageName.test(filename) ||
        !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > lierdaPackageSizeLimit(hardware) ||
        (release.recommended !== undefined && typeof release.recommended !== 'boolean')) return null;
    const releaseFilename = lierdaReleaseFilename(hardware, version);
    const digestPath = `./firmware/${hardware.firmwareKey}-v${version}-${sha256.toLowerCase()}.binpkg`;
    const canonicalPath = `./firmware/v${version}_${hardware.slug}.binpkg`;
    if (![digestPath, './firmware/' + releaseFilename, canonicalPath].includes(release.bin_url)) return null;
    seen.add(version);
    versions.push({ ...release, filename: releaseFilename, bin_url: linkedURL(release.bin_url, catalogURL).href });
  }
  if (versions.filter((release) => release.recommended).length > 1) return null;
  return { slug: hardware.slug, model: board.model.trim(), chip: hardware.chip, flashBytes: hardware.flashBytes, versions };
}

async function readJSON(url, signal, siteOrigin) {
  const requestURL = new URL(url);
  // Keep signed catalog URLs intact. Give ordinary same-site JSON a fresh cache key.
  if (requestURL.origin === siteOrigin && !requestURL.search) {
    requestURL.searchParams.set('_refresh', crypto.getRandomValues(new Uint32Array(2)).join('-'));
  }
  const response = await fetch(requestURL, {
    cache: 'no-store',
    credentials: 'omit',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new LocalizedError('无法读取固件配置。');
  return { data: await response.json(), url: response.url || url.href };
}

export async function loadBoardCatalog(configURL, signal) {
  const siteOrigin = new URL(configURL).origin;
  const config = await readJSON(configURL, signal, siteOrigin);
  const catalogURL = linkedURL(config.data?.boards_url, config.url);
  const catalog = await readJSON(catalogURL, signal, siteOrigin);
  return publishedCatalog(catalog.data, catalog.url);
}

export async function loadBoards(configURL, signal) {
  return (await loadBoardCatalog(configURL, signal)).boards;
}

export async function downloadFirmware(release, capacity, signal) {
  const timeout = AbortSignal.timeout(120000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(release.bin_url, {
    credentials: 'omit',
    signal: downloadSignal,
  });
  if (!response.ok || !response.body) throw new LocalizedError('固件下载失败。');
  const reader = response.body.getReader();
  const output = new Uint8Array(capacity);
  let written = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (written + chunk.value.length > capacity) {
        await reader.cancel();
        throw new LocalizedError('固件超过已连接设备的 Flash 容量。');
      }
      output.set(chunk.value, written);
      written += chunk.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const data = output.subarray(0, written);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  downloadSignal.throwIfAborted();
  const actual = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== release.sha256.toLowerCase())
    throw new LocalizedError('下载固件的 SHA‑256 校验失败。');
  return {
    data,
    size: written,
    name: release.version + t(' 完整镜像'),
    address: 0,
  };
}
