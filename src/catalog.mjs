import { chips } from './chips.mjs';
import { lierdaBoards } from './lierda-boards.mjs';

const versionDigest = /^[a-f0-9]{64}$/i;
const boardSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
    throw new Error('固件配置与 BIN 需使用同源链接或 HTTPS 直链。');
  }
  return url;
}

export function publishedBoards(data, catalogURL) {
  if (!Array.isArray(data?.boards))
    throw new Error('固件配置必须包含 boards 数组。');
  const slugs = new Set();
  return data.boards.flatMap((board) => {
    const hardware = lierdaBoards.find(({ slug }) => slug === board?.slug);
    if (hardware) {
      // An invalid BINPKG entry must never hide another platform's catalog.
      if (data.boards.filter((candidate) => candidate?.slug === hardware.slug).length !== 1) return [];
      const entry = publishedLierdaBoard(board, hardware, catalogURL);
      return entry ? [entry] : [];
    }
    if (lierdaBoards.some(({ chip }) => chip === board?.chip)) return [];
    if (
      typeof board?.slug !== 'string' ||
      !boardSlug.test(board.slug) ||
      slugs.has(board.slug) ||
      typeof board.model !== 'string' ||
      !board.model.trim() ||
      typeof board.chip !== 'string' ||
      !Array.isArray(board.releases)
    ) {
      throw new Error('板卡标识、型号、芯片或版本列表有误。');
    }
    slugs.add(board.slug);
    const chip = board.chip.trim().toUpperCase();
    if (chip !== 'BK7258' && !chips.includes(chip)) return [];
    const flashBytes = board.flash_bytes;
    if (
      flashBytes !== undefined &&
      (!Number.isSafeInteger(flashBytes) || flashBytes <= 0)
    ) {
      throw new Error(`${board.model} 的 Flash 容量配置无效。`);
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
        throw new Error(`${board.model} 的固件版本或发布状态有误。`);
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
        throw new Error(
          `${board.model} ${release.version} 的 BIN 链接或 SHA‑256 有误。`,
        );
      }
      return [{ ...release, version, bin_url: binURL.href }];
    });
    if (versions.filter((release) => release.recommended).length > 1) {
      throw new Error(`${board.model} 只能有一个推荐版本。`);
    }
    if (!versions.length) return [];
    return [
      {
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
        !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > hardware.flashBytes + 0x10000 ||
        (release.recommended !== undefined && typeof release.recommended !== 'boolean')) return null;
    const prefix = hardware.slug.slice('lierda-'.length);
    const path = `./firmware/${prefix}-v${version}-${sha256.toLowerCase()}.binpkg`;
    if (release.bin_url !== path) return null;
    seen.add(version);
    versions.push({ ...release, filename, bin_url: linkedURL(path, catalogURL).href });
  }
  if (versions.filter((release) => release.recommended).length > 1) return null;
  return { slug: hardware.slug, model: board.model.trim(), chip: hardware.chip, flashBytes: hardware.flashBytes, versions };
}

async function readJSON(url, signal) {
  const response = await fetch(url, {
    cache: 'no-cache',
    credentials: 'omit',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('无法读取固件配置。');
  return { data: await response.json(), url: response.url || url.href };
}

export async function loadBoards(configURL, signal) {
  const config = await readJSON(configURL, signal);
  const catalogURL = linkedURL(config.data?.boards_url, config.url);
  const catalog = await readJSON(catalogURL, signal);
  return publishedBoards(catalog.data, catalog.url);
}

export async function downloadFirmware(release, capacity, signal) {
  const timeout = AbortSignal.timeout(120000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(release.bin_url, {
    credentials: 'omit',
    signal: downloadSignal,
  });
  if (!response.ok || !response.body) throw new Error('固件下载失败。');
  const reader = response.body.getReader();
  const output = new Uint8Array(capacity);
  let written = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (written + chunk.value.length > capacity) {
        await reader.cancel();
        throw new Error('固件超过已连接设备的 Flash 容量。');
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
    throw new Error('下载固件的 SHA‑256 校验失败。');
  return {
    data,
    size: written,
    name: release.version + ' 完整镜像',
    address: 0,
  };
}
