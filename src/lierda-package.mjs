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
const ec718hmBaseImages = [
  { role: 'BL', name: 'ap_bootloader', id: 0x4f424d49, address: 0x003000,
    capacity: 0x020000, digest: 'c56c680fff74f274324e1ff17b0ce236be254bd684971c67ae0f694fb47caf55',
    sampleSha: '87ee2d2b52216763d21d24aea181ae4bc20bec8681e1c3464f3c1c00c77f21dd' },
  { role: 'AP', name: 'ap_lierda_app', id: 0x444b4249, address: 0x0cd000,
    capacity: 0x1c8000, digest: '7408bf96a569e6cb7b6854e547529beff065d5b56e950dc4cdf91e3859ddadae',
    sampleSha: '26d07457145adb4e006dbe2eda0b0f5b12136d20d2df3a108a4389ae3747d015' },
  { role: 'CP', name: 'cp-demo-flash', id: 0x43504249, address: 0x02d000,
    capacity: 0x0a0000, digest: '64e88a6b97954749403c4b1a6fed765552a67e033f1cc9e6ee883914aef7ba2b',
    sampleSha: '53bd8180c6ab918866c835f63c626a33ded3559fe6ac2a8fd90c660aa058bba7' },
];
const liteApplication = Object.freeze({
  name: 'TiRTC_lite_NT26F6D0', address: 0x2a6000, capacity: 0x0cb000, fsStart: 0x371000, fsSize: 0x73000,
});
const f9Application = Object.freeze({
  name: 'TiRTC_pro_NT26F9D0', address: 0x2ad000, capacity: 0x2b4000, fsStart: 0x561000, fsSize: 0x276000,
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
const ec718hm = Object.freeze({
  model: 'pro-f9',
  boardLabel: 'NT26F9D0 Pro (F9D_D)',
  chip: 'EC718HM',
  product: 'EC718HM_PRD',
  size: 0x800000,
  baseImages: ec718hmBaseImages,
  app: f9Application,
  eraseRanges: [{ start: f9Application.address, end: f9Application.fsStart }],
  preservedRanges: [{ start: 0, end: f9Application.address }, { start: f9Application.fsStart, end: 0x800000 }],
  applicationOnly: true,
});

const hardwareProfiles = [ec718pm, ec718hm];

export function getLierdaHardwareProfile(model) {
  const hardware = hardwareProfiles.find((candidate) => candidate.model === model);
  if (!hardware) throw new Error('请选择受支持的利尔达板型。');
  return hardware;
}

export function matchLierdaBootFingerprint(digest) {
  return hardwareProfiles.find(({ baseImages }) => baseImages[0].sampleSha === digest);
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
        throw new Error('固件产品标识重复或格式无效。');
      }
      product = readString(data, offset + 68, offset + 132);
    }
    if (field === 'pkgmode') {
      if (mode !== undefined || view.getUint32(offset, true) !== 1) {
        throw new Error('固件打包模式重复或格式无效。');
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
    throw new Error('应用镜像类型与所选利尔达板型不匹配。');
  }
  if (!matchesLierdaApplicationLayout(data, profile)) {
    throw new Error('应用镜像标识或文件系统布局与所选型号分区不匹配。');
  }
}

export async function parseLierdaPackage(input, { model, stage, filename, sha256: expectedSha } = {}) {
  if (stage !== 'app') throw new Error('所选利尔达板型需要应用固件包。');
  const hardware = getLierdaHardwareProfile(model);
  if (!(input instanceof ArrayBuffer || input instanceof Uint8Array)
      || input.byteLength < packageHeaderLength || input.byteLength > hardware.size + 0x10000) {
    throw new Error('请提供匹配的利尔达内部 Flash binpkg。');
  }

  // Use the same snapshot for the container hash, image checks, and transfer.
  const bytes = new Uint8Array(input).slice();
  const view = new DataView(bytes.buffer);
  const specs = [...hardware.baseImages, { role: 'APP', id: 0x464c5849, ...hardware.app }];
  if (!packageMagic.every((byte, index) => bytes[index] === byte)
      || readString(bytes, 20, 26) !== 'SHA256'
      || view.getUint32(16, true) !== specs.length) {
    throw new Error('固件须包含 BL、AP、CP 和 APP 四个内部 Flash 镜像。');
  }
  const count = view.getUint16(28, true);
  const headerLength = view.getUint16(30, true);
  let offset = packageHeaderLength + headerLength;
  if (count * metadataRecordLength !== headerLength || offset + imageHeaderLength > bytes.length
      || productName(bytes, view, offset) !== hardware.product) {
    throw new Error(`固件产品或扩展头与 ${hardware.product} 不匹配。`);
  }

  const sha256 = await lierdaSha256(bytes);
  if (expectedSha !== undefined
      && (typeof expectedSha !== 'string' || sha256 !== expectedSha.toLowerCase())) {
    throw new Error('固件包 SHA-256 与公布的摘要不一致。');
  }
  const images = [];
  for (const spec of specs) {
    const start = offset + imageHeaderLength;
    if (start > bytes.length) throw new Error(`${spec.role} 镜像头越界。`);
    const name = readString(bytes, offset, offset + 64);
    const address = view.getUint32(offset + 64, true) - flashBase;
    const capacity = view.getUint32(offset + 68, true);
    const recordedOffset = view.getUint32(offset + 72, true);
    const length = view.getUint32(offset + 76, true);
    const end = start + length;
    const updateImage = !hardware.applicationOnly || spec.role === 'APP';
    const allowedRanges = updateImage ? hardware.eraseRanges : hardware.preservedRanges;
    const insideRange = allowedRanges.some(({ start, end }) =>
      start <= address && address + capacity <= end);
    if (address !== spec.address || capacity !== spec.capacity || recordedOffset !== offset
        || !length || length > capacity || end > bytes.length || !insideRange
        || (spec.digest && (name !== spec.name || length !== capacity))) {
      throw new Error(`${spec.role} 镜像地址、容量或位置与利尔达分区不匹配。`);
    }
    const data = bytes.subarray(start, end);
    if (!spec.digest) checkApplication(data, hardware.app, name);
    const digest = await lierdaDigest(data);
    const hash = hexBytes(digest);
    if (readString(bytes, offset + 80, offset + 144).toLowerCase() !== hash
        || (spec.digest && hash !== spec.digest)) {
      throw new Error(`${spec.role} 镜像 SHA-256 与固件包或已验证底包不一致。`);
    }
    images.push({ role: spec.role, imageId: spec.id, address, capacity, data, digest, sha: hash });
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('固件有额外镜像或未识别数据。');

  return { bytes, filename, model, stage, sha256, byteLength: bytes.length, images };
}
