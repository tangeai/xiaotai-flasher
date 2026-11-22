const blockSize = 34;
const payloadSize = 32;
const appOffset = 0x11000;

function codeCrc(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 0xffff;
    }
  }
  return crc;
}

export function validateBk7258Image(data) {
  const invalid = () =>
    new Error('请选择适配此板卡的 BK7258 原始 all-app.bin 完整镜像。');
  if (
    !(data instanceof Uint8Array) ||
    data.length < appOffset + blockSize ||
    data
      .subarray(appOffset, appOffset + blockSize)
      .every((byte) => byte === 0xff)
  )
    throw invalid();
  const vectors = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stack = vectors.getUint32(0, true);
  const reset = vectors.getUint32(4, true);
  if (stack >>> 24 !== 0x28 || reset >>> 24 !== 0x02 || !(reset & 1)) {
    throw invalid();
  }
  for (let offset = 0; offset + blockSize <= data.length; offset += blockSize) {
    const block = data.subarray(offset, offset + blockSize);
    if (block.every((byte) => byte === 0xff)) continue;
    const expected = (block[payloadSize] << 8) | block[payloadSize + 1];
    if (codeCrc(block.subarray(0, payloadSize)) !== expected) {
      throw new Error(
        `BK7258 镜像校验失败，文件偏移 0x${offset.toString(16)}。`,
      );
    }
  }
  if (
    data
      .subarray(data.length - (data.length % blockSize))
      .some((byte) => byte !== 0xff)
  ) {
    throw invalid();
  }
}
