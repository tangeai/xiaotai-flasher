const sectorSize = 4096;

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

export function validateBootImage(data, offset, chip) {
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
}
