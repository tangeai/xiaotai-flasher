import { LocalizedError, localizedMessage } from './i18n.mjs';
import { lierdaBoards, lierdaPackageSizeLimit } from './lierda-boards.mjs';

const flashBase = 0x00800000;
const flashSize = 0x00400000;
const packageHeaderLength = 52;
const metadataRecordLength = 140;
const imageHeaderLength = 364;
const packageMagic = Uint8Array.of(0x31, 0x31, 0x31, 0, 0, 0, 0, 0, 0x62, 0x70, 0x6b, 0x67);
const decoder = new TextDecoder('utf-8', { fatal: true });

export const lierdaFingerprintLength = 240;
// Both bootloaders start at 0x3000. Probe past the shared first 240 bytes.
export const lierdaBootFingerprintAddress = 0x3100;

const ec718pmBaseImages = [
  { role: 'BL', name: 'ap_bootloader', id: 0x4f424d49, address: 0x003000,
    capacity: 0x016000, digest: 'f9793d31c60b687f3190d86317ad5fac81c1153e96dd9314360911ded9e1c648',
    sampleSha: '8984343af1cf62774c257cff67d7dd965753343b3c0bf7b457fe545b2593d963' },
  { role: 'AP', name: 'ap_lierda_app', id: 0x444b4249, address: 0x0be000,
    capacity: 0x1d0000, digest: '915ad4beab9042c1e8d22cf3f1db06f185d060b14dbe0f564e81586d454af265',
    sampleSha: 'e844e093c61cee8c5e1d0e9eee0a907d3aa1ba12d1e9419417e50b8b698d5f2b' },
  { role: 'CP', name: 'cp-demo-flash', id: 0x43504249, address: 0x01e000,
    capacity: 0x0a0000, digest: 'c46d3797baed7fe01d70be77c16b0af79ee94a958fb815a3e8150b0864eca6d5',
    sampleSha: '005119e883e823c20e06b94aad883bd59202f3a00f16ace5821b5ae8386f4ddc' },
];
// F9D_D OpenKit 1.7.0 (59f1250c).
const ec718hmBaseImages = [
  { role: 'BL', name: 'ap_bootloader', id: 0x4f424d49, address: 0x003000,
    capacity: 0x020000, digest: '6743229009df330455c6bb9ecd3cf6324c386ee8b733d0d557cb08ab1e3385d1',
    sampleSha: '87ee2d2b52216763d21d24aea181ae4bc20bec8681e1c3464f3c1c00c77f21dd' },
  { role: 'AP', name: 'ap_lierda_app', id: 0x444b4249, address: 0x0cd000,
    capacity: 0x1dc000, digest: '9292a1d1b7c33168dab10bc0bb66c27dd53a1204889a2feaf325cc31e20eecb1',
    sampleSha: '421b0d5cb8f195e98262f1efc537e64b5428e7a01c572fda8e0d9106e6cf3729' },
  { role: 'CP', name: 'cp-demo-flash', id: 0x43504249, address: 0x02d000,
    capacity: 0x0a0000, digest: '64e88a6b97954749403c4b1a6fed765552a67e033f1cc9e6ee883914aef7ba2b',
    sampleSha: '53bd8180c6ab918866c835f63c626a33ded3559fe6ac2a8fd90c660aa058bba7' },
];
const liteApplication = Object.freeze({
  name: 'TiRTC_lite_NT26F6D0', address: 0x2a6000, capacity: 0x0cb000, fsStart: 0x371000, fsSize: 0x73000,
});

// Factory EC718PM erallum with the live BL/AP headers and fuse mirror excluded.
// The base-image digests above and live readback in lierda.mjs validate this choice.
export const lierdaEraseRanges = Object.freeze([
  Object.freeze({ start: 0x003000, end: 0x019000 }),
  Object.freeze({ start: 0x01e000, end: 0x3f1000 }),
  Object.freeze({ start: 0x3fe000, end: flashSize }),
]);
export const lierdaPreservedRanges = Object.freeze([
  Object.freeze({ start: 0, end: 0x003000 }),
  Object.freeze({ start: 0x019000, end: 0x01e000 }),
  Object.freeze({ start: 0x3f1000, end: 0x3fe000 }),
]);
export { flashBase, flashSize };

const ec718pm = Object.freeze({
  model: 'lite',
  boardLabel: 'NT26F6D0 Lite (F6D_D)',
  chip: 'EC718PM',
  product: 'EC718PM_PRD',
  size: flashSize,
  baseImages: ec718pmBaseImages,
  app: liteApplication,
  eraseRanges: lierdaEraseRanges,
  preservedRanges: lierdaPreservedRanges,
  applicationOnly: false,
});
function hmProfile(sdkVersion, baseImages, address, fsStart, fsSize) {
  const size = 0x800000;
  const app = Object.freeze({ name: 'TiRTC_pro_NT26F9D0', address, capacity: 0x2b4000, fsStart, fsSize });
  return Object.freeze({
    model: 'pro-f9',
    sdkVersion,
    boardLabel: 'NT26F9D0 Pro (F9D_D)',
    chip: 'EC718HM',
    product: 'EC718HM_PRD',
    size,
    baseImages,
    app,
    eraseRanges: [{ start: address, end: fsStart }],
    preservedRanges: [{ start: 0, end: address }, { start: fsStart, end: size }],
    applicationOnly: true,
  });
}
const hm170 = hmProfile('1.7.0', ec718hmBaseImages, 0x2c1000, 0x575000, 0x262000);
// F9D_D 1.7.1 shares CP and the short BL sample with 1.7.0.
const hm171 = hmProfile('1.7.1', [
  { ...ec718hmBaseImages[0], digest: 'c56c680fff74f274324e1ff17b0ce236be254bd684971c67ae0f694fb47caf55' },
  { ...ec718hmBaseImages[1], capacity: 0x1c8000,
    digest: '7408bf96a569e6cb7b6854e547529beff065d5b56e950dc4cdf91e3859ddadae',
    sampleSha: '26d07457145adb4e006dbe2eda0b0f5b12136d20d2df3a108a4389ae3747d015' },
  ec718hmBaseImages[2],
], 0x2ad000, 0x561000, 0x276000);

const hardwareProfiles = [ec718pm, hm170, hm171];

// Two 4 KiB sectors, each holding a 272-byte USB image header padded with FF.
// The BL and AP headers use controls=4, baud=0 and the full image hashes above.
// The 1.7.1 result also matches a physical NT26F9D0 backup byte for byte.
const hmBootHeadersSha256 = new Map([
  [hm170, 'c29828aacd164ddfa97156ffc79ff96af92ba3a510426b68b5aa455a597d6856'],
  [hm171, '81b66e2963add60971f6349d15175a256cdbf1854596248cb5648fe0137c4820'],
]);

export async function validateHmBootHeaders(bytes, profile) {
  const expected = hmBootHeadersSha256.get(profile);
  if (!expected || !(bytes instanceof Uint8Array) || bytes.length < 0x2000
      || await lierdaSha256(bytes.subarray(0, 0x2000)) !== expected) {
    throw new LocalizedError('设备启动头与已验证的 HM 固件布局不匹配。');
  }
  return true;
}

// The PM Pro distribution bundle includes internal firmware and an external
// LittleFS image. Its package map is intentionally separate from the hardware
// profiles used to select a live device and issue erase/write commands.
const pmProExternalFs = Object.freeze({
  role: 'EXT', name: 'ext_lfs', address: 0x80000000, capacity: 0x400000,
});
const pmProBundle = Object.freeze({
  product: 'EC718PM_PRD',
  baseImages: ec718pmBaseImages,
  app: { name: 'TiRTC_pro_NT26F6D0', address: 0x2a6000, capacity: 0x116000,
    fsStart: 0x3bc000, fsSize: 0x28000 },
  storageRanges: [{ start: 0, end: flashSize },
    { start: pmProExternalFs.address, end: pmProExternalFs.address + pmProExternalFs.capacity }],
});

export function getLierdaHardwareProfile(model, sdkVersion) {
  const hardware = hardwareProfiles.find((candidate) => candidate.model === model
    && (sdkVersion === undefined || candidate.sdkVersion === sdkVersion));
  if (!hardware) throw new LocalizedError('请选择受支持的利尔达板型。');
  return hardware;
}

// F9D_D factory NV, fuse mirror and platform information survive a clean install.
// BL and AP downloads regenerate the two boot-header sectors. A reinstall
// must verify their target hashes before resetting the device.
const hmReinstallEraseRanges = Object.freeze([
  Object.freeze({ start: 0x000000, end: 0x002000 }),
  Object.freeze({ start: 0x003000, end: 0x023000 }),
  Object.freeze({ start: 0x02d000, end: 0x7e4000 }),
]);
const hmReinstallPreservedRanges = Object.freeze([
  Object.freeze({ start: 0x002000, end: 0x003000 }),
  Object.freeze({ start: 0x023000, end: 0x02d000 }),
  Object.freeze({ start: 0x7e4000, end: 0x800000 }),
]);

export function getLierdaFlashPlan(deviceProfile, packageProfile) {
  if (!hardwareProfiles.includes(deviceProfile) || !hardwareProfiles.includes(packageProfile)
      || deviceProfile.model !== packageProfile.model) {
    throw new LocalizedError('应用镜像类型与所选利尔达板型不匹配。');
  }
  if (deviceProfile === packageProfile) {
    return { mode: deviceProfile.applicationOnly ? 'app' : 'full',
      eraseRanges: deviceProfile.eraseRanges, preservedRanges: deviceProfile.preservedRanges };
  }
  if ((deviceProfile === hm170 && packageProfile === hm171)
      || (deviceProfile === hm171 && packageProfile === hm170)) {
    return { mode: 'reinstall', eraseRanges: hmReinstallEraseRanges, preservedRanges: hmReinstallPreservedRanges };
  }
  throw new LocalizedError('请选择受支持的利尔达板型。');
}

export function lierdaBootCandidates(digest) {
  return hardwareProfiles.filter(({ baseImages }) => baseImages[0].sampleSha === digest);
}

export function matchLierdaBootFingerprint(digest, apDigest) {
  const candidates = lierdaBootCandidates(digest).filter(({ baseImages }) =>
    apDigest === undefined || baseImages[1].sampleSha === apDigest);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function readString(data, start, end) {
  return decoder.decode(data.subarray(start, end)).replace(/\0+$/u, '');
}

export function hexBytes(data, separator = '') {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(separator);
}

export async function lierdaDigest(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function lierdaSha256(data) {
  return hexBytes(await lierdaDigest(data));
}

function productName(data, view, headerEnd) {
  let product = '';
  let mode;
  for (let offset = packageHeaderLength; offset < headerEnd; offset += metadataRecordLength) {
    const field = readString(data, offset + 4, offset + 68);
    if (field === 'productname') {
      if (product || view.getUint32(offset, true) !== 2) {
        throw new LocalizedError('固件产品标识重复或格式无效。');
      }
      product = readString(data, offset + 68, offset + 132);
    }
    if (field === 'pkgmode') {
      if (mode !== undefined || view.getUint32(offset, true) !== 1) {
        throw new LocalizedError('固件打包模式重复或格式无效。');
      }
      mode = view.getUint32(offset + 68, true);
    }
  }
  return mode === 1 ? product : '';
}

export function matchesLierdaApplicationLayout(data, { fsStart, fsSize }) {
  if (data.length < 24 || hexBytes(data.subarray(0, 4)) !== '61707030') return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(16, true) === fsStart && view.getUint32(20, true) === fsSize;
}

function checkApplication(data, profile, name) {
  const matchesName = name === profile.name
    || (name.startsWith(`${profile.name}_`) && /^[\w.-]+$/u.test(name));
  if (!matchesName) {
    throw new LocalizedError('应用镜像类型与所选利尔达板型不匹配。');
  }
  if (!matchesLierdaApplicationLayout(data, profile)) {
    throw new LocalizedError('应用镜像标识或文件系统布局与所选型号分区不匹配。');
  }
}

export async function parseLierdaPackage(input, { model, stage, filename, sha256: expectedSha } = {}) {
  if (stage !== 'app') throw new LocalizedError('所选利尔达板型需要应用固件包。');
  const pmPro = model === 'pro-pm';
  const boardProfile = pmPro ? pmProBundle : getLierdaHardwareProfile(model);
  const board = lierdaBoards.find(board => board.model === model);
  if (!(input instanceof ArrayBuffer || input instanceof Uint8Array)
      || input.byteLength < packageHeaderLength || input.byteLength > lierdaPackageSizeLimit(board)) {
    throw new LocalizedError(pmPro ? '请提供 NT26F6D0 Pro 的完整 BINPKG。' : '请提供匹配的利尔达内部 Flash binpkg。');
  }

  // Use the same snapshot for the container hash, image checks, and transfer.
  const bytes = new Uint8Array(input).slice();
  const view = new DataView(bytes.buffer);
  if (!packageMagic.every((byte, index) => bytes[index] === byte)
      || readString(bytes, 20, 26) !== 'SHA256') {
    throw new LocalizedError('BINPKG 文件头无效或哈希格式不受支持。');
  }
  const imageCount = view.getUint32(16, true);
  const expectedImageCount = pmPro ? 5 : 4;
  if (imageCount > expectedImageCount) {
    throw new LocalizedError(pmPro
      ? '固件包含此板型暂不支持的额外镜像或配置。'
      : '此板型仅支持四个内部 Flash 镜像。固件含额外镜像或配置。');
  }
  if (imageCount < expectedImageCount) {
    if (pmPro) throw new LocalizedError('NT26F6D0 Pro 需要包含 BL、AP、CP、APP 和 ext_lfs 的完整固件包。');
    throw new LocalizedError('固件须包含 BL、AP、CP 和 APP 四个内部 Flash 镜像。');
  }
  const count = view.getUint16(28, true);
  const headerLength = view.getUint16(30, true);
  let offset = packageHeaderLength + headerLength;
  if (count * metadataRecordLength !== headerLength || offset + imageHeaderLength > bytes.length
      || productName(bytes, view, offset) !== boardProfile.product) {
    throw new LocalizedError(localizedMessage('固件产品或扩展头与 @0 不匹配。', boardProfile.product));
  }

  const sha256 = await lierdaSha256(bytes);
  if (expectedSha !== undefined
      && (typeof expectedSha !== 'string' || sha256 !== expectedSha.toLowerCase())) {
    throw new LocalizedError('固件包 SHA-256 与公布的摘要不一致。');
  }
  // The full BL digest identifies the proposed HM layout. Every image is
  // then hashed and checked against that layout before a plan is returned.
  const profile = model === 'pro-f9'
    && readString(bytes, offset + 80, offset + 144).toLowerCase() === hm171.baseImages[0].digest
    ? hm171 : boardProfile;
  const specs = [...profile.baseImages, { role: 'APP', id: 0x464c5849, ...profile.app }];
  if (pmPro) specs.push(pmProExternalFs);
  const images = [];
  for (const spec of specs) {
    const start = offset + imageHeaderLength;
    if (start > bytes.length) throw new LocalizedError(localizedMessage('@0 镜像头越界。', spec.role));
    const name = readString(bytes, offset, offset + 64);
    const external = spec === pmProExternalFs;
    const address = view.getUint32(offset + 64, true) - (external ? 0 : flashBase);
    const capacity = view.getUint32(offset + 68, true);
    const recordedOffset = view.getUint32(offset + 72, true);
    const length = view.getUint32(offset + 76, true);
    const end = start + length;
    const allowedRanges = profile.storageRanges ??
      (profile.applicationOnly && spec.role !== 'APP' ? profile.preservedRanges : profile.eraseRanges);
    const insideRange = allowedRanges.some(({ start, end }) =>
      start <= address && address + capacity <= end);
    if (address !== spec.address || capacity !== spec.capacity || recordedOffset !== offset
        || !length || length > capacity || end > bytes.length || !insideRange
        || ((spec.digest || external) && (name !== spec.name || length !== capacity))) {
      throw new LocalizedError(localizedMessage('@0 镜像地址、容量或位置与利尔达分区不匹配。', spec.role));
    }
    const data = bytes.subarray(start, end);
    if (spec.role === 'APP') checkApplication(data, profile.app, name);
    if (external && String.fromCharCode(...data.subarray(8, 16)) !== 'littlefs') {
      throw new LocalizedError('NT26F6D0 Pro 的 ext_lfs 缺少外置 LittleFS 文件系统标识。');
    }
    const digest = await lierdaDigest(data);
    const hash = hexBytes(digest);
    if (readString(bytes, offset + 80, offset + 144).toLowerCase() !== hash) {
      throw new LocalizedError(localizedMessage('@0 镜像 SHA-256 与固件包记录不一致。', spec.role));
    }
    if (spec.digest && hash !== spec.digest) {
      throw new LocalizedError(localizedMessage('@0 镜像与已验证底包不一致。', spec.role));
    }
    images.push({ role: spec.role, imageId: spec.id, address, capacity, data, digest, sha: hash });
    offset = end;
  }
  if (offset !== bytes.length) throw new LocalizedError('固件有额外镜像或未识别数据。');

  return { bytes, filename, model, stage, sha256, byteLength: bytes.length, images, profile };
}
