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

function device({
  wrongChip = false,
  mismatch = false,
  shortBootWindow = false,
  requiresRts = false,
  hasRts = requiresRts,
  rejectBaud = false,
  ackOnly = false,
  bufferSwitch = false,
  ignoreSwitch = false,
  gd25wq64e = false,
  dropWriteReply = false,
  bufferReset = false,
  loseFirstWriteAck = null,
  assertRtsOnReopen = false,
} = {}) {
  let probes = 0;
  let bootTimer;
  const signals = [];
  const openRates = [];
  let targetRate = 115200;
  let bufferedRate;
  let pendingReset;
  let resetHeld = false;
  let lostWriteAck = false;
  const storage = Buffer.alloc(capacity, 0x5a);
  const status = [0x1c, 0x40];
  const operations = [];
  const statusWrites = [];
  const erases = [];
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
    signals,
    openRates,
    statusWrites,
    erases,
    ...((hasRts || assertRtsOnReopen) && {
      async setSignals(state) {
        assert.equal(state.dataTerminalReady, false);
        signals.push(state.requestToSend);
        resetHeld = state.requestToSend;
      },
    }),
    async open(options) {
      if (!bufferSwitch && !ignoreSwitch)
        assert.equal(options.baudRate, targetRate);
      if (assertRtsOnReopen && openRates.length) resetHeld = true;
      openRates.push(options.baudRate);
      if (rejectBaud && options.baudRate !== 115200)
        throw new Error('unsupported by adapter');
      this.readable = new ReadableStream({
        start(controller) {
          incoming = controller;
        },
      });
      if (ackOnly && targetRate !== 115200) {
        const ack = Buffer.alloc(5);
        ack.writeUInt32LE(targetRate);
        ack[4] = 200;
        short(0x0f, ack);
      }
      this.writable = new WritableStream({
        close() {
          if (bufferedRate) targetRate = bufferedRate;
          if (pendingReset) operations.push('reset');
        },
        write(request) {
          if (
            options.baudRate !== targetRate ||
            (assertRtsOnReopen && resetHeld)
          )
            return;
          const frame = Buffer.from(request);
          assert.deepEqual([...frame.subarray(0, 3)], [1, 224, 252]);
          if (frame[3] !== 0xff) {
            assert.equal(frame[3], frame.length - 4);
            const opcode = frame[4];
            if (opcode === 0x00) {
              if (ackOnly && targetRate !== 115200) return;
              if (requiresRts && signals.join(',') !== 'true,false') return;
              if (!shortBootWindow) return short(0x01, [0]);
              probes += 1;
              if (probes === 1) {
                bootTimer = setTimeout(() => incoming.close(), 50);
              } else if (probes === 2) {
                clearTimeout(bootTimer);
                incoming.enqueue(Uint8Array.of(4, 14, 5, 1));
                setTimeout(
                  () => incoming.enqueue(Uint8Array.of(224, 252, 1, 0)),
                  22,
                );
              }
              return;
            }
            if (opcode === 0x0f) {
              assert.equal(frame.length, 10);
              assert.equal(frame[9], 200);
              const next = frame.readUInt32LE(5);
              if (bufferSwitch) bufferedRate = next;
              else if (!ignoreSwitch) targetRate = next;
              operations.push('set-baud');
              return;
            }
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
            if (bufferReset) pendingReset = true;
            else operations.push('reset');
            return;
          }
          assert.equal(frame[4], 0xf4);
          assert.equal(frame.readUInt16LE(5), frame.length - 7);
          const opcode = frame[7];
          const payload = frame.subarray(8);
          switch (opcode) {
            case 0x0e:
              return extended(opcode, [
                0x9f,
                0xc8,
                gd25wq64e ? 0x65 : 0x40,
                0x17,
              ]);
            case 0x0c:
              return extended(opcode, [
                payload[0],
                status[payload[0] === 0x05 ? 0 : 1],
              ]);
            case 0x0d:
              if (gd25wq64e)
                assert.equal(
                  payload.length,
                  2,
                  'GD25WQ64E writes each status register separately',
                );
              statusWrites.push(payload[0]);
              status[payload[0] === 0x01 ? 0 : 1] = payload[1];
              return extended(opcode, payload);
            case 0x0f:
            case 0x0b: {
              const block = opcode === 0x0f;
              const address = payload.readUInt32LE(block ? 1 : 0);
              const bytes = block ? 65536 : 4096;
              if (block) assert.equal(payload[0], 0xd8);
              assert.equal(address % bytes, 0);
              storage.fill(0xff, address, address + bytes);
              erases.push([address, bytes]);
              operations.push('erase');
              return extended(opcode, payload);
            }
            case 0x07: {
              assert.equal(payload.length, 4100);
              assert.deepEqual(status, [0, 0]);
              if (dropWriteReply) {
                incoming.close();
                return;
              }
              const address = payload.readUInt32LE(0);
              if (loseFirstWriteAck && !lostWriteAck) {
                lostWriteAck = true;
                const end =
                  loseFirstWriteAck === 'partial' ? 12 : payload.length;
                payload.copy(storage, address, 4, end);
                return;
              }
              payload.copy(storage, address, 4);
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
  assert.deepEqual(serial.erases, [
    [0, 65536],
    [0x10000, 4096],
    [0x11000, 4096],
  ]);
  assert.equal(serial.storage[0x12000], 0x5a);
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

test('BK7258 catches a short reset window and accepts a split BootROM reply across retries', async () => {
  const serial = device({ shortBootWindow: true });
  const session = await connectBk7258(serial, {}, () => {});
  assert.equal(session.chip, 'BK7258');
  await session.close();
});

test('BK7258 connects without a manual reset on an RTS-wired board', async () => {
  const serial = device({ requiresRts: true });
  const session = await connectBk7258(serial, {}, () => {});
  assert.deepEqual(serial.signals, [true, false]);
  assert.equal(session.chip, 'BK7258');
  await session.close();
});

test('BK7258 switches to the chosen write rate and verifies the device before erasing', async () => {
  const serial = device();
  const session = await connectBk7258(serial, {}, () => {});
  assert.deepEqual(serial.openRates, [115200]);
  const data = imageFixture();
  await session.write([{ address: 0, data }], { baudrate: 1500000 }, () => {});
  assert.deepEqual(serial.openRates, [115200, 1500000]);
  assert.deepEqual(serial.operations.slice(0, 2), ['set-baud', 'erase']);
  assert.deepEqual(serial.storage.subarray(0, data.length), data);
  await session.reset();
  await session.close();
});

test('BK7258 stops before Flash writes when the USB adapter rejects the selected rate', async () => {
  const serial = device({ rejectBaud: true });
  const session = await connectBk7258(serial, {}, () => {});
  await assert.rejects(
    session.write(
      [{ address: 0, data: imageFixture() }],
      { baudrate: 2000000 },
      () => {},
    ),
    /无法确认 2000000 波特率.*调低/,
  );
  assert.deepEqual(serial.operations, ['set-baud']);
  assert.deepEqual(serial.status, [0x1c, 0x40]);
  await session.close();
});

test('BK7258 manual reset mode releases RTS without pulsing it', async () => {
  const serial = device({ hasRts: true });
  const session = await connectBk7258(serial, { before: 'manual' }, () => {});
  assert.deepEqual(serial.signals, [false]);
  await session.close();
});

test('BK7258 accepts the switch acknowledgement even if the target does not repeat the boot probe', async () => {
  const serial = device({ ackOnly: true });
  const session = await connectBk7258(serial, {}, () => {});
  try {
    await session.write(
      [{ address: 0, data: imageFixture() }],
      { baudrate: 2000000 },
      () => {},
    );
    assert.deepEqual(serial.openRates, [115200, 2000000]);
    assert.deepEqual(serial.operations.slice(0, 2), ['set-baud', 'erase']);
  } finally {
    await session.close();
  }
});

test('BK7258 drains the queued 2 Mbps switch command before closing the old port', async () => {
  const serial = device({ bufferSwitch: true, ackOnly: true });
  const session = await connectBk7258(serial, {}, () => {});
  try {
    await session.write(
      [{ address: 0, data: imageFixture() }],
      { baudrate: 2000000 },
      () => {},
    );
    assert.deepEqual(serial.openRates, [115200, 2000000]);
    assert.deepEqual(serial.operations.slice(0, 2), ['set-baud', 'erase']);
  } finally {
    await session.close();
  }
});

test('BK7258 diagnoses a target still at 115200 after the high-speed port receives no data', async () => {
  const serial = device({ ignoreSwitch: true });
  const log = [];
  const session = await connectBk7258(serial, {}, (line) => log.push(line));
  try {
    await assert.rejects(
      session.write(
        [{ address: 0, data: imageFixture() }],
        { baudrate: 2000000 },
        () => {},
      ),
      /无法确认 2000000 波特率/,
    );
    assert.deepEqual(serial.openRates, [115200, 2000000, 115200]);
    assert.deepEqual(serial.operations, ['set-baud']);
    assert.match(log.join(''), /切速后串口收到 0 字节/);
    assert.match(log.join(''), /仍能在 115200 读到相同芯片 ID/);
  } finally {
    await session.close();
  }
});

test('BK7258 unprotects and restores GD25WQ64E with separate SR1 and SR2 writes', async () => {
  const serial = device({ gd25wq64e: true });
  const session = await connectBk7258(serial, {}, () => {});
  try {
    const data = imageFixture();
    await session.write([{ address: 0, data }], { baudrate: 115200 }, () => {});
    assert.deepEqual(serial.openRates, [115200]);
    assert.deepEqual(serial.statusWrites, [0x01, 0x31, 0x01, 0x31]);
    assert.deepEqual(serial.storage.subarray(0, data.length), data);
    assert.deepEqual(serial.status, [0x1c, 0x40]);
  } finally {
    await session.close();
  }
});

test('BK7258 identifies the write address when the first sector receives no reply', async () => {
  const serial = device({ dropWriteReply: true });
  const lines = [];
  const session = await connectBk7258(serial, {}, (line) => lines.push(line));
  try {
    await assert.rejects(
      session.write([{ address: 0, data: imageFixture() }], {}, () => {}),
      /写入 Flash 地址 0x0失败（收到 0 字节）/,
    );
    assert.deepEqual(serial.operations, ['erase']);
    assert.match(lines.join(''), /使用 115200 波特率.*SR1=0x1c，SR2=0x40/);
  } finally {
    await session.close();
  }
});

test('BK7258 transmits a queued reboot command before releasing the port', async () => {
  const serial = device({ bufferReset: true });
  const session = await connectBk7258(serial, {}, () => {});
  assert.match(await session.reset(), /已发送复位命令/);
  assert.deepEqual(serial.operations, ['reset']);
  assert.equal(serial.readable, null);
  await session.close();
});

test('BK7258 recovers from a lost write reply using the sector CRC', async () => {
  await Promise.all(
    ['written', 'partial'].map(async (mode) => {
      const serial = device({ loseFirstWriteAck: mode });
      const log = [];
      const session = await connectBk7258(serial, {}, (line) => log.push(line));
      try {
        const data = imageFixture();
        await session.write([{ address: 0, data }], {}, () => {});
        assert.deepEqual(serial.storage.subarray(0, data.length), data);
        assert.deepEqual(serial.status, [0x1c, 0x40]);
        const repairs = serial.erases.filter(
          ([address, bytes]) => address === 0 && bytes === 4096,
        );
        assert.equal(repairs.length, mode === 'partial' ? 1 : 0);
        assert.match(
          log.join(''),
          mode === 'partial' ? /正在重写 0x0 扇区/ : /已确认 0x0 扇区写入正确/,
        );
      } finally {
        await session.close();
      }
    }),
  );
});

test('BK7258 releases RTS after Windows reopens the port at 2 Mbps', async () => {
  const serial = device({ assertRtsOnReopen: true });
  const session = await connectBk7258(serial, { before: 'manual' }, () => {});
  try {
    await session.write(
      [{ address: 0, data: imageFixture() }],
      { baudrate: 2000000 },
      () => {},
    );
    assert.deepEqual(serial.openRates, [115200, 2000000]);
    assert.equal(serial.signals.at(-1), false);
    assert.ok(serial.signals.every((signal) => signal === false));
    assert.ok(serial.operations.includes('write'));
  } finally {
    await session.close();
  }
});
