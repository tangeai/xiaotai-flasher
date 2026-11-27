import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lpcWire as wire } from './fixtures/lierda-port.mjs';
import { flashImageHeader } from '../src/lierda-serial.mjs';
import {
  configurePmProExternal, pmProExternalSize, preparePmProExternalWrite, readPmProExternal,
} from '../src/lierda-spi.mjs';

const configFrame = 'e0004cb30d000010010100000500000021030103195c58dd34';
const readFirstFrame = '24004cb31e0000be010000000000000001ef0200000006454649443031000000000000000000f26eb709';
const prepareFrame = 'e0004cb32900001a4201000021000000100645464944303100000000000000000049584c46000000800000000000004000d33a7112';

test('PM Pro builds the verified factory AGBOOT header for the published external resource image', async () => {
  const header = await flashImageHeader({
    role: 'EXT', imageId: 0x464c5849, address: 0x80000000, data: { length: pmProExternalSize },
    digest: Buffer.from('c184cd3b14119484c657bc73febf34bbe07eac4cfe5ab895aa5616b1067bb4f2', 'hex'),
  });
  assert.equal(header.length, 272);
  assert.equal(Buffer.from(header.subarray(32, 64)).toString('hex'),
    '15810ba5d823e57b0b9c472e09aea73ac97ab10cee76480a064cae3652114527');
});

test('PM Pro configures board power and selects an external image at storage offset zero', async () => {
  const image = { role: 'EXT', imageId: 0x464c5849, address: 0x80000000,
    capacity: pmProExternalSize, data: new Uint8Array(pmProExternalSize) };
  await configurePmProExternal(wire(request => {
    assert.equal(request.toString('hex'), configFrame);
    return { data: Buffer.from([5, 0, 0, 0]) };
  }));
  await assert.rejects(configurePmProExternal(wire(() => ({ data: Buffer.alloc(4) }))), /供电/);
  await preparePmProExternalWrite(wire(request => {
    assert.equal(request.toString('hex'), prepareFrame);
    return { data: Buffer.alloc(0) };
  }), image);
  await assert.rejects(preparePmProExternalWrite(wire(assert.fail), { ...image, address: 0 }), /EFID01/);
});

test('PM Pro validates full 64 KiB block replies and slices requested external ranges', async () => {
  const seen = [];
  const io = wire(request => {
    const offset = request.readUInt32LE(12);
    seen.push(offset);
    if (offset === 0) assert.equal(request.toString('hex'), readFirstFrame);
    return { data: Buffer.alloc(65536, offset >>> 16), size: 0xfa };
  });
  const result = await readPmProExternal(io, 65533, 5);
  assert.deepEqual([...result], [0, 0, 0, 1, 1]);
  assert.deepEqual(seen, [0, 65536]);
  await assert.rejects(readPmProExternal(wire(assert.fail), pmProExternalSize - 1, 2), /范围/);
  await assert.rejects(readPmProExternal(wire(() => ({ data: Buffer.alloc(0) })), 0, 1), /标识/);
  await assert.rejects(readPmProExternal(wire(() => ({
    data: Buffer.alloc(65536), size: 0xfa, damage: true,
  })), 0, 1), /CRC32/);
  await assert.rejects(readPmProExternal(wire(() => ({ data: Buffer.alloc(0), status: 0x3e })), 0, 1), /0x3e/);
});
