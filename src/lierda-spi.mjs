import { LocalizedError } from './i18n.mjs';
import {
  LPC_FLASH_BLOCK_READ, LPC_FLASH_BLOCK_SIZE, LPC_SYNC, sendCommand, synchronize, words,
} from './lierda-serial.mjs';

export const pmProExternalSize = 0x400000;
const storageName = new TextEncoder().encode('EFID01');
const flexImageId = 0x464c5849;

async function externalCommand(io, subcommand, body) {
  const payload = new Uint8Array(8 + body.length);
  payload.set(words(subcommand, body.length));
  payload.set(body, 8);
  await synchronize(io, LPC_SYNC, 'LPC');
  return sendCommand(io, 0xe0, payload, { lpc: true });
}

export async function configurePmProExternal(io) {
  // PM Pro V04 board-control IE: 3.3 V, active-high power enable on GPIO25.
  const reply = await externalCommand(io, 0x101, Uint8Array.of(0x21, 3, 1, 3, 25));
  if (reply.length !== 4 || (reply[0] & 1) === 0) {
    throw new LocalizedError('PM Pro 外置 Flash 供电配置未获确认。');
  }
}

export async function readPmProExternal(io, offset, length, onProgress = () => {}) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length <= 0 || length > pmProExternalSize - offset) {
    throw new LocalizedError('PM Pro 外置 Flash 回读范围无效。');
  }
  const result = new Uint8Array(length);
  const end = offset + length;
  const payload = new Uint8Array(30);
  // Single block, storage-id IE (external), storage-name IE (EFID01).
  payload.set([1, 0xef, 2, 0, 0, 0, storageName.length], 8);
  payload.set(storageName, 15);
  await synchronize(io, LPC_SYNC, 'LPC');
  for (let start = offset - offset % LPC_FLASH_BLOCK_SIZE; start < end; start += LPC_FLASH_BLOCK_SIZE) {
    payload.set(words(1, start));
    const block = await sendCommand(io, LPC_FLASH_BLOCK_READ, payload, { lpc: true });
    const first = Math.max(start, offset);
    const last = Math.min(start + block.length, end);
    result.set(block.subarray(first - start, last - start), first - offset);
    onProgress(last - offset, length);
  }
  return result;
}

export async function preparePmProExternalWrite(io, image) {
  if (image.role !== 'EXT' || image.imageId !== flexImageId || image.address !== 0x80000000
      || image.capacity !== pmProExternalSize || image.data?.length !== pmProExternalSize) {
    throw new LocalizedError('PM Pro 外置 Flash 需要完整的 4 MiB EFID01 镜像。');
  }
  const body = new Uint8Array(33);
  body.set([0x10, storageName.length]);
  body.set(storageName, 2);
  // The trigger carries both the storage's logical base and a relative offset.
  // The following AGBOOT image header uses only the offset (zero).
  body.set(words(flexImageId, image.address, 0, pmProExternalSize), 17);
  const reply = await externalCommand(io, 0x142, body);
  if (reply.length !== 0) throw new LocalizedError('PM Pro 外置 Flash 写入准备应答无效。');
}
