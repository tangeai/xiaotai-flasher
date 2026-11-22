import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectBk7258 } from '../src/bk7258.mjs';
import { validateBk7258Image } from '../src/bk7258-image.mjs';

const bootOffset = 0x11000;
const capacity = 8 * 1024 * 1024;

function imageFixture() {
  const data = Buffer.alloc(bootOffset + 34, 0xff);
  data.fill(0, 0, 32);
  data.writeUInt32LE(0x28030000, 0);
  data.writeUInt32LE(0x020001c1, 4);
  data.fill(0, bootOffset, bootOffset + 32);
  // CRC16 of the vector block and of 32 zero bytes.
  data.writeUInt16BE(0, 32);
  data.writeUInt16BE(0x8029, bootOffset + 32);
  const block = data.subarray(0, 32);
  let crc = 0xffff;
  for (const byte of block) {
    for (let bit = 7; bit >= 0; bit--) {
      crc =
        ((crc << 1) ^ (((crc >>> 15) ^ (byte >>> bit)) & 1 ? 0x8005 : 0)) &
        0xffff;
    }
  }
  data.writeUInt16BE(crc, 32);
  return data;
}

function device({ wrongChip = false, mismatch = false } = {}) {
  const storage = Buffer.alloc(capacity, 0x5a);
  const status = [0x1c, 0x40];
  const operations = [];
  let incoming;
  const send = (response) => {
    incoming.enqueue(Uint8Array.of(0x20, 0x04));
    incoming.enqueue(Uint8Array.from(response.slice(1, 5)));
    incoming.enqueue(Uint8Array.from(response.slice(5)));
  };
  const short = (opcode, payload) =>
    send([4, 14, 4 + payload.length, 1, 224, 252, opcode, ...payload]);
  const extended = (opcode, payload) =>
    send([
      4,
      14,
      255,
      1,
      224,
      252,
      244,
      2 + payload.length,
      0,
      opcode,
      0,
      ...payload,
    ]);

  return {
    storage,
    status,
    operations,
    async open(options) {
      assert.equal(options.baudRate, 115200);
      this.readable = new ReadableStream({
        start(controller) {
          incoming = controller;
        },
      });
      this.writable = new WritableStream({
        write(request) {
          const frame = Buffer.from(request);
          assert.deepEqual([...frame.subarray(0, 3)], [1, 224, 252]);
          if (frame[3] !== 0xff) {
            assert.equal(frame[3], frame.length - 4);
            const opcode = frame[4];
            if (opcode === 0x00) return short(0x01, [0]);
            if (opcode === 0x03) {
              const register = frame.readUInt32LE(5);
              const reply = Buffer.alloc(8);
              reply.writeUInt32LE(register, 0);
              if (register === 0x44010004)
                reply.writeUInt32LE(wrongChip ? 0x7256 : 0x72360101, 4);
              else if (register === 0x440001f0)
                reply.writeUInt32LE(0x20340b10, 4);
              else throw Error('Unknown register');
              return short(opcode, reply);
            }
            if (opcode === 0x10) {
              let crc = 0xffffffff;
              const start = frame.readUInt32LE(5);
              const end = frame.readUInt32LE(9);
              for (const byte of storage.subarray(start, end + 1)) {
                crc ^= byte;
                for (let bit = 0; bit < 8; bit += 1)
                  crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
              }
              const payload = Buffer.alloc(4);
              payload.writeUInt32LE((mismatch ? crc ^ 1 : crc) >>> 0, 0);
              return short(opcode, payload);
            }
            assert.equal(opcode, 0x0e);
            assert.equal(frame[5], 0xa5);
            operations.push('reset');
            return;
          }
          assert.equal(frame[4], 0xf4);
          assert.equal(frame.readUInt16LE(5), frame.length - 7);
          const opcode = frame[7];
          const payload = frame.subarray(8);
          switch (opcode) {
            case 0x0e:
              return extended(opcode, [0x9f, 0xc8, 0x40, 0x17]);
            case 0x0c:
              return extended(opcode, [
                payload[0],
                status[payload[0] === 0x05 ? 0 : 1],
              ]);
            case 0x0d:
              status[payload[0] === 0x01 ? 0 : 1] = payload[1];
              return extended(opcode, payload);
            case 0x0b: {
              const address = payload.readUInt32LE(0);
              storage.fill(0xff, address, address + 4096);
              operations.push('erase');
              return extended(opcode, payload);
            }
            case 0x07: {
              assert.equal(payload.length, 4100);
              assert.deepEqual(status, [0, 0]);
              payload.copy(storage, payload.readUInt32LE(0), 4);
              operations.push('write');
              return extended(opcode, payload.subarray(0, 4));
            }
            default:
              throw Error('Unknown flash operation');
          }
        },
      });
    },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      this.readable = this.writable = null;
    },
  };
}

test('BK7258 rejects OTA, mutated and bootloader-only input', () => {
  const data = imageFixture();
  validateBk7258Image(data);
  assert.throws(
    () => validateBk7258Image(data.subarray(0, 0x11000)),
    /all-app/,
  );
  const damaged = Buffer.from(data);
  damaged[0x11000 + 4] ^= 1;
  assert.throws(() => validateBk7258Image(damaged), /镜像校验失败/);
  assert.throws(() => validateBk7258Image(Buffer.from('beken...')), /all-app/);
});

test('BK7258 flashes at zero, verifies CRC, restores protection and resets', async () => {
  const serial = device();
  const session = await connectBk7258(serial, {}, () => {});
  assert.equal(session.chip, 'BK7258');
  assert.equal(session.capacity, capacity);
  const data = imageFixture();
  const progress = [];
  await session.write([{ address: 0, data }], {}, (value) =>
    progress.push(value),
  );
  assert.deepEqual(serial.storage.subarray(0, data.length), data);
  assert.deepEqual(serial.status, [0x1c, 0x40]);
  assert.equal(progress.at(-1), 1);
  await session.reset();
  assert.equal(serial.operations.at(-1), 'reset');
  await session.close();
});

test('BK7258 rejects the wrong chip and restores protection on CRC failure', async () => {
  const other = device({ wrongChip: true });
  await assert.rejects(
    connectBk7258(other, {}, () => {}),
    /芯片标识/,
  );
  assert.deepEqual(other.operations, []);
  assert.equal(other.readable, null);
  const serial = device({ mismatch: true });
  const session = await connectBk7258(serial, {}, () => {});
  await assert.rejects(
    session.write([{ address: 0, data: imageFixture() }], {}, () => {}),
    /Flash CRC/,
  );
  assert.deepEqual(serial.status, [0x1c, 0x40]);
  await session.close();
});
