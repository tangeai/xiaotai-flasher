import { downloadFirmware } from './catalog.mjs';

const liteFlashBytes = 0x400000;
const proFlashBytes = 0x800000;

const liteRelease = Object.freeze({
  version: '1.0.0 · xiaotai-lierda Lite',
  filename: '2026_11_21_16_05_10_lite.binpkg',
  bin_url: 'https://raw.githubusercontent.com/tangeai/xiaotai-lierda/60fcfd56e39b9aff679f167702aa41215fa2f6b5/examples/NT26FxDx_OpenKit/firmware/lite/2026_11_21_16_05_10_lite.binpkg',
  byte_length: 3449160,
  sha256: '41cfc6373f03c0d3bf4d480dfabec0c527bfc03b5fbdd4849e984715c266f98e',
});

export const lierdaBoards = Object.freeze([
  Object.freeze({
    model: 'lite',
    slug: 'lierda-lite',
    name: 'Lite NT26F6D0 语音通话版',
    chip: 'EC718PM',
    flashBytes: liteFlashBytes,
    release: liteRelease,
  }),
  Object.freeze({
    model: 'pro-f9',
    slug: 'lierda-pro',
    name: 'Pro 视频通话版 · NT26F9D0',
    chip: 'EC718HM',
    flashBytes: proFlashBytes,
  }),
]);

const packageOverhead = 0x10000;
const onlinePackageName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,249}\.binpkg$/i;

async function fetchLierdaManifest(url, signal, label) {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(url, {
    cache: 'no-cache',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('暂时无法读取 ' + label + ' 固件目录。');
  return response.json();
}

function normalizeLierdaRelease(entry, url, { label, modem, modempkg, flashBytes }) {
  if (entry?.modem !== modem || entry.modempkg !== modempkg
      || typeof entry.version !== 'string' || !entry.version.trim()
      || typeof entry.filename !== 'string' || !onlinePackageName.test(entry.filename)
      || !Number.isSafeInteger(entry.byte_length) || entry.byte_length <= 0
      || entry.byte_length > flashBytes + packageOverhead
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
    throw new Error(label + ' 固件目录配置无效。');
  }
  return {
    version: entry.version.trim(),
    filename: entry.filename,
    byte_length: entry.byte_length,
    sha256: entry.sha256.toLowerCase(),
    bin_url: new URL(entry.filename, url).href,
  };
}

export async function loadLierdaLiteReleases(signal, baseURL = document.baseURI) {
  const url = new URL('./lierda/firmware/lite.json', baseURL);
  const manifest = await fetchLierdaManifest(url, signal, 'Lite');
  if (manifest === undefined) return null;
  if (!Array.isArray(manifest?.releases)) throw new Error('Lite 固件目录配置无效。');

  const releases = manifest.releases.map((entry) => {
    const release = normalizeLierdaRelease(entry, url, {
      label: 'Lite', modem: 'NT26F6D0', modempkg: 'F6D_D', flashBytes: liteFlashBytes,
    });
    if (entry.source_filename !== undefined) {
      if (typeof entry.source_filename !== 'string' || !onlinePackageName.test(entry.source_filename)) {
        throw new Error('Lite 固件目录配置无效。');
      }
      release.filename = entry.source_filename;
    } else if (release.sha256 === liteRelease.sha256 && release.byte_length === liteRelease.byte_length) {
      // The first catalog stored only the SHA-qualified download name.
      release.filename = liteRelease.filename;
    }
    return { ...release, recommended: entry.recommended === true };
  });
  if (new Set(releases.map(({ version }) => version)).size !== releases.length) {
    throw new Error('Lite 固件目录包含重复版本。');
  }
  return releases;
}

export async function loadLierdaProRelease(signal, baseURL = document.baseURI) {
  const url = new URL('./lierda/firmware/pro.json', baseURL);
  const entry = await fetchLierdaManifest(url, signal, 'Pro');
  if (entry === undefined) return null;
  return normalizeLierdaRelease(entry, url, {
    label: 'Pro', modem: 'NT26F9D0', modempkg: 'F9D_D', flashBytes: proFlashBytes,
  });
}

export function prepareLierdaFirmware({ model, file, origin, selectedRelease, proRelease }, capacity) {
  const board = lierdaBoards.find((candidate) => candidate.model === model);
  if (!board) throw new Error('请选择实际连接的利尔达 Lite 或 Pro 板型。');
  if (capacity != null && capacity !== board.flashBytes) {
    throw new Error('已连接设备的 Flash 容量与所选利尔达板型不匹配。');
  }

  const firmware = {
    kind: 'lierda',
    model: board.model,
    chip: board.chip,
    flashBytes: board.flashBytes,
    boardModel: board.name,
    origin,
  };

  if (origin === 'official') {
    const release = selectedRelease ?? board.release ?? proRelease;
    if (!release) throw new Error('暂未加载 Pro 小钛固件，可导入本地 F9D_D BINPKG。');
    return { ...firmware, release, filename: release.filename };
  }
  if (origin !== 'local') throw new Error('请选择固件来源。');
  if (typeof file?.arrayBuffer !== 'function') throw new Error('请选择完整的本地 BINPKG 固件。');
  if (typeof file.name !== 'string' || !/^.+\.binpkg$/i.test(file.name)) {
    throw new Error('利尔达固件文件扩展名应为 .binpkg。');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('BINPKG 固件文件为空或文件大小无效。');
  }
  if (file.size > board.flashBytes + packageOverhead) {
    throw new Error(`BINPKG 超出 ${board.name} 的固件包大小限制。`);
  }
  return { ...firmware, file, filename: file.name };
}

export async function resolveLierdaFirmware(firmware, signal) {
  if (firmware?.kind !== 'lierda') throw new Error('请选择利尔达 BINPKG 固件。');
  signal?.throwIfAborted();
  const { origin, model, filename, file, release } = prepareLierdaFirmware({
    ...firmware, selectedRelease: firmware.release,
  });
  const selection = { model, stage: 'app', filename };

  if (origin === 'official') {
    const { data, size } = await downloadFirmware(release, release.byte_length, signal);
    if (size !== release.byte_length) throw new Error('下载固件的文件大小与发布信息不一致。');
    return { ...selection, bytes: data, sha256: release.sha256 };
  }

  const expectedSize = file.size;
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  if (bytes.byteLength !== expectedSize) throw new Error('本地固件的文件大小发生变化。');
  return { ...selection, bytes };
}
