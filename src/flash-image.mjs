import { LocalizedError, localizedMessage } from './i18n.mjs';
import SparkMD5 from 'spark-md5';

const sectorSize = 4096;
const imageHeaderSize = 24;
const segmentHeaderSize = 8;
const digestSize = 32;
const partitionEntrySize = 32;
const partitionTableSize = 0xc00;
const partitionMagic = 0x50aa;
const partitionDigestMagic = 0xebeb;
const appPartitionAlignment = 0x10000;
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
      throw new LocalizedError(localizedMessage('「@0」的地址或大小超出 Flash 范围。', name));
    }
    if (Math.floor(address / sectorSize) * sectorSize < end) {
      throw new LocalizedError(localizedMessage('「@0」与其他固件占用了相同的擦除扇区。', name));
    }
    end = Math.ceil((address + size) / sectorSize) * sectorSize;
  }
}

export async function validateBootImage(data, offset, chip) {
  return validateImage(data, offset, chip, true);
}

async function validateImage(data, offset, chip, boot) {
  const invalid = () =>
    new LocalizedError(
      localizedMessage('@0镜像不完整，或镜像校验失败。请重新获取固件。', localizedMessage(boot ? '启动' : '应用')),
    );
  if (offset < 0 || offset + 36 > data.length || data[offset] !== 0xe9) {
    if (!boot) throw invalid();
    throw new LocalizedError(
      '完整镜像缺少当前芯片所需的启动镜像。请确认文件是适配本板的完整 BIN。',
    );
  }
  const header = new DataView(
    data.buffer,
    data.byteOffset + offset,
    data.byteLength - offset,
  );
  if (header.getUint16(12, true) !== chip.IMAGE_CHIP_ID) {
    throw new LocalizedError('镜像头中的芯片型号与连接设备不匹配。');
  }
  if (boot && header.getUint32(32, true) === 0xabcd5432) {
    throw new LocalizedError(
      '这个 BIN 是 ESP-IDF 应用镜像。请改用完整镜像，或按固件说明进行分段烧录。',
    );
  }
  const segmentCount = header.getUint8(1);
  const digestFlag = header.getUint8(23);
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

function readAppPartitions(data, entries, tableOffset, capacity) {
  const apps = [];
  const end = Math.min(tableOffset + partitionTableSize, data.length);
  let hasDigest = false;
  for (
    let offset = tableOffset;
    offset + partitionEntrySize <= end;
    offset += partitionEntrySize
  ) {
    const magic = entries.getUint16(offset, true);
    const rawEntry = data.subarray(offset, offset + partitionEntrySize);
    if (rawEntry.every((byte) => byte === 0xff)) return apps;
    if (hasDigest) break;
    if (magic === partitionDigestMagic) {
      const prefix = data.buffer.slice(
        data.byteOffset + tableOffset,
        data.byteOffset + offset,
      );
      const digest = SparkMD5.ArrayBuffer.hash(prefix, true);
      if (
        !rawEntry.subarray(2, 16).every((byte) => byte === 0xff) ||
        !rawEntry
          .subarray(16)
          .every((byte, index) => byte === digest.charCodeAt(index))
      )
        break;
      hasDigest = true;
      continue;
    }
    if (magic !== partitionMagic) break;
    if (entries.getUint8(offset + 2) !== 0) continue;
    const address = entries.getUint32(offset + 4, true);
    const size = entries.getUint32(offset + 8, true);
    if (
      address < tableOffset + sectorSize ||
      address % appPartitionAlignment !== 0 ||
      !size ||
      address + size > capacity
    ) break;
    apps.push({ address, size });
  }
  return [];
}

export async function validateCompleteImage(data, boot, chip, capacity) {
  const bootEnd = boot.digestOffset + (boot.hasDigest ? digestSize : 0);
  const entries = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // ESP-IDF allows the partition table to move to another flash sector.
  for (
    let offset = Math.ceil(bootEnd / sectorSize) * sectorSize;
    offset + partitionEntrySize <= data.length;
    offset += sectorSize
  ) {
    if (entries.getUint16(offset, true) !== partitionMagic) continue;
    const apps = readAppPartitions(data, entries, offset, capacity);
    for (const { address, size } of apps) {
      if (data[address] !== 0xe9) continue;
      try {
        await validateImage(
          data.subarray(0, address + size),
          address,
          chip,
          false,
        );
        return;
      } catch {
        // A different partition may contain the image, such as an OTA slot.
      }
    }
  }
  throw new LocalizedError(
    '完整 BIN 缺少有效的 ESP32 应用镜像或分区表。请重新获取适配本板的固件。',
  );
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
    throw new LocalizedError('当前芯片不支持所选的 Flash 参数。');
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
