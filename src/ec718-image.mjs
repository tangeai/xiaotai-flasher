const flashBytes = 0x400000;
const headerBytes = 0x1d8;
const entryBytes = 364;
const xipBase = 0x800000;
export const ec718PackageLimit = flashBytes + headerBytes + 3 * entryBytes;
export const ec718AgentSize = 50788;
export const ec718AgentSha256 =
  '0db9e8f3462140c7c368723aa144b976ac033ae45fc6d37db5d959b1c9238019';
const identifiers = { BL: 0x4f424d49, AP: 0x444b4249, CP: 0x43504249 };
const decoder = new TextDecoder();
function cString(data) {
  const end = data.indexOf(0);
  return decoder.decode(end < 0 ? data : data.subarray(0, end));
}
const hex = (data) =>
  Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

export async function validateEc718Agent(data) {
  if (
    data.length !== ec718AgentSize ||
    hex(await sha256(data)) !== ec718AgentSha256
  ) {
    throw new Error(
      'USB AgentBoot 校验失败，请选择 Air780EPM 支持的 ec718m_usb.bin。',
    );
  }
}

// Layout and image types follow the Air780EPM package described by LuatOS CLI.
export async function parseEc718Package(data) {
  if (
    data.length < headerBytes ||
    data.length > ec718PackageLimit ||
    cString(data.subarray(8, 12)) !== 'bpkg' ||
    cString(data.subarray(0x38, 0x3f)) !== 'pkgmode' ||
    cString(data.subarray(0x190, 0x1a0)) !== 'EC718PM_PRD'
  ) {
    throw new Error('请选择 Air780EPM 的 EC718PM_PRD 固件包（.binpkg）。');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = headerBytes;
  const partitions = [];
  for (const type of ['BL', 'AP', 'CP']) {
    const start = offset + entryBytes;
    if (
      start > data.length ||
      cString(data.subarray(offset + 336, offset + 352)) !== type
    )
      throw new Error('固件包必须按 BL、AP、CP 顺序包含三个分区。');

    const address = view.getUint32(offset + 64, true);
    const flashSize = view.getUint32(offset + 68, true);
    const declaredOffset = view.getUint32(offset + 72, true);
    const size = view.getUint32(offset + 76, true);
    const relative = address >= xipBase ? address - xipBase : address;
    const end = relative + flashSize;
    if (
      declaredOffset !== offset ||
      size === 0 ||
      size > flashSize ||
      start + size > data.length ||
      end > flashBytes ||
      partitions.some((other) => relative < other.end && end > other.relative)
    ) {
      throw new Error(`${type} 分区的地址、长度或文件偏移无效。`);
    }

    const image = data.subarray(start, start + size);
    const digest = await sha256(image);
    const expected = cString(
      data.subarray(offset + 80, offset + 336),
    ).toLowerCase();
    if (hex(digest) !== expected)
      throw new Error(`${type} 分区的 SHA-256 校验失败。`);
    partitions.push({
      type,
      identifier: identifiers[type],
      address: type === 'BL' ? 0 : relative,
      relative,
      end,
      data: image,
      digest,
    });
    offset = start + size;
  }
  if (offset !== data.length) throw new Error('固件包包含额外数据或未知分区。');
  return partitions;
}
