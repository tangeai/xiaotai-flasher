const sectorSize = 4096;
const imageHeaderSize = 24;
const segmentHeaderSize = 8;
const digestSize = 32;
const flashModes = { qio: 0, qout: 1, dio: 2, dout: 3 };

export function parseAddress(value) {
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) return NaN;
  const address = Number(value);
  return Number.isSafeInteger(address) && address <= 0xffffffff ? address : NaN;
}

export function validateLayout(images, capacity) {
  let end = 0;
  for (const { name, address, size } of [...images].sort(
    (a, b) => a.address - b.address,
  )) {
    if (
      !Number.isSafeInteger(address) ||
      address < 0 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      address + size > capacity
    ) {
      throw new Error(`「${name}」的地址或大小超出 Flash 范围。`);
    }
    if (Math.floor(address / sectorSize) * sectorSize < end) {
      throw new Error(`「${name}」与其他固件占用了相同的擦除扇区。`);
    }
    end = Math.ceil((address + size) / sectorSize) * sectorSize;
  }
}

export async function validateBootImage(data, offset, chip) {
  if (offset + 36 > data.length || data[offset] !== 0xe9) {
    throw new Error(
      '完整镜像缺少当前芯片所需的启动镜像。请确认文件是适配本板的完整 BIN。',
    );
  }
  const header = new DataView(
    data.buffer,
    data.byteOffset + offset,
    data.byteLength - offset,
  );
  if (header.getUint16(12, true) !== chip.IMAGE_CHIP_ID) {
    throw new Error('镜像头中的芯片型号与连接设备不匹配。');
  }
  if (header.getUint32(32, true) === 0xabcd5432) {
    throw new Error(
      '这个 BIN 是 ESP-IDF 应用镜像。请改用完整镜像，或按固件说明进行分段烧录。',
    );
  }
  const segmentCount = header.getUint8(1);
  const digestFlag = header.getUint8(23);
  const invalid = () =>
    new Error('启动镜像不完整，或镜像校验失败。请重新获取固件。');
  if (!segmentCount || segmentCount > 16 || digestFlag > 1) throw invalid();

  let cursor = imageHeaderSize;
  let checksum = 0xef;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    if (cursor + segmentHeaderSize > header.byteLength) throw invalid();
    const length = header.getUint32(cursor + 4, true);
    cursor += segmentHeaderSize;
    const end = cursor + length;
    if (end > header.byteLength) throw invalid();
    for (; cursor < end; cursor += 1) checksum ^= data[offset + cursor];
  }
  const digestOffset = offset + Math.ceil((cursor + 1) / 16) * 16;
  if (digestOffset > data.length || data[digestOffset - 1] !== checksum)
    throw invalid();
  if (digestFlag) {
    const stored = data.subarray(digestOffset, digestOffset + digestSize);
    const calculated = await bootDigest(data, offset, digestOffset);
    if (
      stored.length !== digestSize ||
      calculated.some((byte, index) => stored[index] !== byte)
    ) {
      throw invalid();
    }
  }
  return { digestOffset, hasDigest: Boolean(digestFlag) };
}

async function bootDigest(data, offset, digestOffset) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', data.subarray(offset, digestOffset)),
  );
}

export async function updateBootSettings(
  data,
  offset,
  boot,
  chip,
  options,
  detectedSize,
) {
  const { flashMode, flashFreq, flashSize } = options;
  const size = flashSize === 'detect' ? detectedSize : flashSize;
  const mode = flashMode === 'keep' ? data[offset + 2] : flashModes[flashMode];
  const frequency =
    flashFreq === 'keep'
      ? data[offset + 3] & 0x0f
      : chip.FLASH_FREQUENCY[flashFreq];
  const capacity =
    size === 'keep' ? data[offset + 3] & 0xf0 : chip.FLASH_SIZES[size];
  if (![mode, frequency, capacity].every(Number.isInteger)) {
    throw new Error('当前芯片不支持所选的 Flash 参数。');
  }
  if (data[offset + 2] === mode && data[offset + 3] === (capacity | frequency))
    return data;
  const updated = new Uint8Array(data);
  updated[offset + 2] = mode;
  updated[offset + 3] = capacity | frequency;
  if (boot.hasDigest) {
    updated.set(
      await bootDigest(updated, offset, boot.digestOffset),
      boot.digestOffset,
    );
  }
  return updated;
}
