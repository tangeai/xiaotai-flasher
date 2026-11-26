import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { connectLierda } from '../src/lierda.mjs';
import { parseLierdaBaudrate, USB_BAUD } from '../src/lierda-serial.mjs';
import { makeHmFixture, simulateHmFlash } from './fixtures/lierda-hm.mjs';

function useSyntheticAgent(t, pinnedHashes = new Map()) {
  // The vendor binary is supplied at deployment. Stub its pinned digest only;
  // the ROM transfer, LPC frames and Flash sample hashes use the normal code.
  const agent = new Uint8Array(50032);
  t.mock.method(globalThis, 'fetch', async () => new Response(agent));
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, data) => {
    if (data.byteLength === agent.length) {
      return Uint8Array.from(Buffer.from('045bd0c74a030143230f07484e4711600005b992e3b0776be042e42d141a38e5', 'hex')).buffer;
    }
    if (pinnedHashes.size) {
      const pinned = pinnedHashes.get(createHash('sha256').update(data).digest('hex'));
      if (pinned) return Uint8Array.from(Buffer.from(pinned, 'hex')).buffer;
    }
    return digest(algorithm, data);
  });
}

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Without a Flash simulator the LPC stage only accepts READ_MEM.
function downloadPort(sample, { romVersion = '0000030301000000', corruptRead = false, slow = false, stallAgent, stallDetection, flash } = {}) {
  let nextImage = 0x54494d48;
  let repliedToSync = false;
  const reads = [];
  const agentBauds = [];
  const commands = [];
  return {
    getInfo: () => ({ usbVendorId: 0x17d1, usbProductId: 0x0001 }),
    connected: true, reads, agentBauds, commands,
    async setSignals() {},
    async open({ baudRate }) {
      this.openedBaud = baudRate;
      let device;
      this.readable = new ReadableStream({ start(controller) { device = controller; } });
      this.writable = new WritableStream({ async write(bytes, controller) {
        const frame = Buffer.from(bytes);
        if (frame.length === 4) {
          if (!repliedToSync) device.enqueue(Buffer.concat([frame, Buffer.of(0)]));
          repliedToSync = !repliedToSync;
          return;
        }
        repliedToSync = false;
        commands.push(frame[0]);
        const header = Buffer.from(frame.subarray(0, 4));
        if (flash && (frame[2] === 0x4c || flash.programming)) {
          const payload = flash.reply(frame);
          if (frame[2] !== 0x4c && frame[0] === 0x32) header[1] = (header[1] + 1) & 0xff;
          const reply = Buffer.concat([header, Buffer.of(0, payload.length), payload]);
          device.enqueue(Buffer.concat([reply, uint32(crc32(reply))]));
          return;
        }
        if (frame[2] === 0x4c) {
          assert.equal(frame[0], 0x21);
          reads.push(frame.readUInt32LE(12));
          assert.equal(frame.readUInt32LE(8), sample.length);
          if (stallDetection) {
            stallDetection.resolve();
            return;
          }
          const reply = Buffer.concat([header, Buffer.of(0, sample.length), sample]);
          device.enqueue(reply.subarray(0, 6));
          const payload = Buffer.concat([sample, uint32(corruptRead ? 0 : crc32(reply))]);
          if (slow) setTimeout(() => device.enqueue(payload), 1100);
          else device.enqueue(payload);
          return;
        }
        let payload = Buffer.alloc(0);
        switch (frame[0]) {
          case 0x20: payload = Buffer.from(romVersion, 'hex'); break;
          case 0x21:
            payload = uint32(nextImage);
            nextImage = 0x4f424d49;
            break;
          case 0x31: payload = frame.subarray(8, 12); break;
          case 0x32:
            header[1]++;
            if (frame.readUInt32LE(4) === 272) agentBauds.push(frame.readUInt16LE(8 + 22));
            if (stallAgent && frame.length > 50000) {
              stallAgent.resolve(controller.signal);
              await new Promise(done => controller.signal.addEventListener('abort', done, { once: true }));
              return;
            }
            if (slow && frame.length > 50000) await new Promise(resolve => setTimeout(resolve, 3100));
            break;
          case 0x22:
          case 0x3a: break;
          default: assert.fail('Unexpected boot command ' + frame[0]);
        }
        device.enqueue(Buffer.concat([header, Buffer.of(0, payload.length), payload]));
      } });
    },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      this.readable = this.writable = null;
    },
  };
}

test('unknown BL keeps the download port connected and rejects writing before any backup or erase', async (t) => {
  useSyntheticAgent(t);
  const sample = Buffer.alloc(240, 0xa5);
  const port = downloadPort(sample, { romVersion: '000003030100000001202420' });
  const log = [];
  const session = await connectLierda(port, { model: 'lite' }, line => log.push(line));
  assert.equal(port.openedBaud, USB_BAUD);
  assert.deepEqual(port.agentBauds, [0x8000 + USB_BAUD / 100]);
  assert.ok(port.readable && port.writable);
  assert.equal(session.chip, null);
  assert.equal(session.lierdaModel, null);
  assert.equal(session.capacity, null);
  assert.equal(session.capacityLabel, null);
  assert.match(session.lierdaCompatibilityIssue, /引导程序（BL）.*暂时无法烧录/);
  assert.match(log.join(''), new RegExp(createHash('sha256').update(sample).digest('hex')));
  await assert.rejects(session.writeLierda(null, { onProgress: assert.fail, saveBackup: assert.fail }),
    { message: session.lierdaCompatibilityIssue });
  await assert.rejects(session.reset(), /请先完成写入/);
  assert.deepEqual(port.reads, [0x803100]);
  await session.close();
  assert.equal(port.readable, null);
  assert.equal(port.writable, null);
});

test('read-only ROM query distinguishes additional vendor revisions and stops before image selection', async t => {
  useSyntheticAgent(t);
  for (const [romVersion, reason] of [
    ['000003030200000001202420', /已识别移芯 ROM 0000000203030000.*FlashToolCLI/],
    ['0000030303000000', /已识别移芯 ROM 0000000303030000.*FlashToolCLI/],
    ['0000030304000000', /不匹配.*00 00 03 03 04 00 00 00/],
    ['0000030302', /不匹配.*00 00 03 03 02/],
  ]) {
    const port = downloadPort(Buffer.alloc(240), { romVersion });
    await assert.rejects(connectLierda(port), reason);
    assert.deepEqual(port.commands, [0x20]);
    assert.equal(port.readable, null);
    assert.equal(port.writable, null);
  }
});

test('cancellation before open and a rejected open never close another owner’s port', async t => {
  useSyntheticAgent(t);
  const port = downloadPort(Buffer.alloc(240));
  const reason = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(connectLierda(port, { signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(port.openedBaud, undefined);
  const alreadyOpen = new DOMException('Already open', 'InvalidStateError');
  port.open = async () => { throw alreadyOpen; };
  port.readable = new ReadableStream();
  port.writable = new WritableStream();
  await assert.rejects(connectLierda(port), error => error === alreadyOpen);
  assert.ok(port.readable && port.writable);
});

test('cancel returns during an outstanding open and closes its eventual port', { timeout: 2500 }, async t => {
  useSyntheticAgent(t);
  const port = downloadPort(Buffer.alloc(240));
  const controller = new AbortController();
  const opening = deferred();
  const allowOpen = deferred();
  const closed = deferred();
  port.open = async () => {
    opening.resolve();
    await allowOpen.promise;
    port.readable = new ReadableStream();
    port.writable = new WritableStream();
  };
  port.close = async () => {
    port.readable = port.writable = null;
    closed.resolve();
  };
  const attempt = connectLierda(port, { signal: controller.signal });
  await opening.promise;
  controller.abort();
  await assert.rejects(attempt, error => error === controller.signal.reason);
  allowOpen.resolve();
  await closed.promise;
  assert.equal(port.readable, null);
});

test('cancel interrupts a slow RAM transfer and a pending device detection read', { timeout: 4000 }, async t => {
  useSyntheticAgent(t);
  t.mock.method(globalThis, 'fetch', assert.fail);
  for (const phase of ['stallAgent', 'stallDetection']) {
    const controller = new AbortController();
    const reached = deferred();
    const port = downloadPort(Buffer.alloc(240), { [phase]: reached });
    const attempt = connectLierda(port, {
      baudrate: 100, signal: controller.signal, agent: new Uint8Array(50032),
    });
    const writerSignal = await reached.promise;
    controller.abort();
    await assert.rejects(attempt, error => error === controller.signal.reason);
    assert.equal(port.readable, null);
    assert.equal(port.writable, null);
    if (phase === 'stallAgent') assert.equal(writerSignal.aborted, true);
  }
});

test('a corrupt LPC read fails the connection and releases the port', async (t) => {
  useSyntheticAgent(t);
  const port = downloadPort(Buffer.alloc(240), { corruptRead: true });
  await assert.rejects(connectLierda(port), /CRC32 校验失败/);
  assert.deepEqual(port.reads, [0x803100]);
  assert.equal(port.readable, null);
  assert.equal(port.writable, null);
});

test('a slow QDLoader uses the selected rate for the port, AgentBoot header and transfer deadlines', async t => {
  useSyntheticAgent(t);
  const port = downloadPort(Buffer.alloc(240), { slow: true });
  const session = await connectLierda(port, { baudrate: '2400' });
  try {
    assert.equal(port.openedBaud, 2400);
    assert.deepEqual(port.agentBauds, [0x8000 + 24]);
    assert.deepEqual(port.reads, [0x803100]);
  } finally {
    await session.close();
  }
});

test('only baud rates that fit the AgentBoot header reach the serial port', async t => {
  t.mock.method(globalThis, 'fetch', assert.fail);
  const port = downloadPort(Buffer.alloc(240));
  for (const input of [0, -100, 100.1, 101, 3276800, '', ' 100', '100\n', '1e4', '0x64', NaN, null, true]) {
    assert.equal(parseLierdaBaudrate(input), null);
    await assert.rejects(connectLierda(port, { baudrate: input }), /QDLoader 波特率/);
  }
  for (const rate of [100, 9600, 115200, USB_BAUD, 3276700]) {
    assert.equal(parseLierdaBaudrate(rate), rate);
    assert.equal(parseLierdaBaudrate(String(rate)), rate);
  }
  assert.equal(port.openedBaud, undefined);
});

async function checkHmUpdate(t, version, otherVersion) {
  const pins = new Map();
  const installed = makeHmFixture(version, pins);
  const incompatible = makeHmFixture(otherVersion, pins);
  useSyntheticAgent(t, pins);
  const { appStart, fsStart } = installed.layout;
  const before = Buffer.from(installed.memory);
  const flash = simulateHmFlash(installed.memory);
  const port = downloadPort(null, { flash });
  const session = await connectLierda(port);
  try {
    assert.equal(session.lierdaModel, 'pro-f9', session.lierdaCompatibilityIssue);
    assert.equal(session.lierdaProfile.sdkVersion, version);
    assert.equal(session.capacity, 0x800000);
    await assert.rejects(session.writeLierda(incompatible.firmware(), { saveBackup: assert.fail }),
      /底包|重装/);
    await assert.rejects(session.writeLierda(installed.firmware(incompatible.layout), { saveBackup: assert.fail }),
      /应用镜像标识或文件系统布局/);
    assert.deepEqual(flash.erased, []);
    assert.deepEqual(flash.prepared, []);
    const result = await session.writeLierda(installed.firmware(), { saveBackup: saveHmBackup(flash, before) });
    assert.deepEqual(result.verifiedImages, [{
      role: 'APP', sha256: createHash('sha256').update(installed.app).digest('hex'), length: installed.app.length,
    }]);
    assert.deepEqual(flash.prepared, [0x464c5849]);
    assert.deepEqual(flash.erased, Array.from({ length: (fsStart - appStart) / 0x1000 },
      (_, i) => appStart + i * 0x1000));
    assert.deepEqual(flash.written, [
      { start: appStart, length: 0x10000 },
      { start: appStart + 0x10000, length: installed.app.length - 0x10000 },
    ]);
    const expected = Buffer.from(before);
    expected.fill(0xff, appStart, fsStart);
    installed.app.copy(expected, appStart);
    assert.ok(expected.equals(installed.memory), 'byte-for-byte verification of all 8 MiB');
  } finally {
    await session.close();
  }
}

function saveHmBackup(flash, before) {
  return async (bytes, digest) => {
    assert.ok(before.equals(bytes));
    assert.equal(digest, createHash('sha256').update(before).digest('hex'));
    flash.markBackupSaved();
    return 'simulated-original.bin';
  };
}

for (const [installed, other] of [['1.7.0', '1.7.1'], ['1.7.1', '1.7.0']]) {
  test('HM Pro ' + installed + ' defaults to backup and verified APP-only writes',
    t => checkHmUpdate(t, installed, other));

  test('confirmed HM Pro reinstall from ' + installed + ' to ' + other + ' verifies the destination and clears AppFS', async t => {
    const pins = new Map();
    const source = makeHmFixture(installed, pins);
    const target = makeHmFixture(other, pins);
    useSyntheticAgent(t, pins);
    const before = Buffer.from(source.memory);
    const flash = simulateHmFlash(source.memory);
    const port = downloadPort(null, { flash });
    const session = await connectLierda(port);
    try {
      const result = await session.writeLierda(target.firmware(), {
        allowReinstall: true, saveBackup: saveHmBackup(flash, before),
      });
      assert.deepEqual(result.verifiedImages.map(image => image.role), ['BL', 'AP', 'CP', 'APP']);
      assert.deepEqual(flash.prepared, [0x4f424d49, 0x444b4249, 0x43504249, 0x464c5849]);
      const expected = Buffer.from(before);
      const sectors = [];
      for (const [start, end] of [[0, 0x2000], [0x3000, 0x23000], [0x2d000, 0x7e4000]]) {
        expected.fill(0xff, start, end);
        for (let address = start; address < end; address += 0x1000) sectors.push(address);
      }
      assert.deepEqual(flash.erased, sectors);
      target.memory.copy(expected, 0, 0, 0x2000);
      for (const image of target.bases) image.bytes.copy(expected, image.start);
      target.app.copy(expected, target.layout.appStart);
      assert.ok(expected.equals(source.memory), 'verify the new boot headers, images, empty gaps/FS and all protected data');
      await session.reset();
      assert.equal(port.commands.at(-1), 0xaa);
    } finally {
      await session.close();
    }
  });
}

test('stale HM boot metadata blocks reset after the four destination images are programmed', async t => {
  const pins = new Map();
  const source = makeHmFixture('1.7.0', pins);
  const target = makeHmFixture('1.7.1', pins);
  useSyntheticAgent(t, pins);
  const before = Buffer.from(source.memory);
  const flash = simulateHmFlash(source.memory, { onImageWritten(id) {
    if (id === 0x444b4249) before.copy(source.memory, 0x1000, 0x1000, 0x2000);
  } });
  const port = downloadPort(null, { flash });
  const session = await connectLierda(port);
  try {
    await assert.rejects(session.writeLierda(target.firmware(), {
      allowReinstall: true, saveBackup: saveHmBackup(flash, before),
    }), /启动头/);
    assert.equal(flash.prepared.length, 4);
    await assert.rejects(session.reset(), /请先完成/);
    assert.ok(!port.commands.includes(0xaa));
  } finally {
    await session.close();
  }
});

test('invalid installed HM boot metadata blocks even a confirmed clean reinstall before erase', async t => {
  const pins = new Map();
  const source = makeHmFixture('1.7.1', pins);
  const target = makeHmFixture('1.7.0', pins);
  source.memory[0x1020] ^= 1;
  useSyntheticAgent(t, pins);
  const flash = simulateHmFlash(source.memory);
  const session = await connectLierda(downloadPort(null, { flash }));
  try {
    await assert.rejects(session.writeLierda(target.firmware(), {
      allowReinstall: true, saveBackup: assert.fail,
    }), /启动头/);
    assert.deepEqual(flash.erased, []);
    assert.deepEqual(flash.prepared, []);
  } finally {
    await session.close();
  }
});

test('HM Pro rejects an unknown AP or a mismatched installed APP before erasing', async t => {
  const pins = new Map();
  const supported = makeHmFixture('1.7.0', pins);
  const other = makeHmFixture('1.7.1', pins);
  useSyntheticAgent(t, pins);
  const wrongApp = Buffer.from(supported.memory);
  other.app.copy(wrongApp, supported.layout.appStart, 0, 24);
  const unknownAp = Buffer.from(other.memory);
  unknownAp[0xcd000] ^= 1;
  for (const [memory, issue] of [[unknownAp, /AP/], [wrongApp, /应用|APP/]]) {
    const flash = simulateHmFlash(memory);
    const port = downloadPort(null, { flash });
    const session = await connectLierda(port);
    try {
      assert.equal(session.lierdaModel, null);
      assert.match(session.lierdaCompatibilityIssue, issue);
      await assert.rejects(session.writeLierda(supported.firmware(), { saveBackup: assert.fail }), issue);
      assert.deepEqual(flash.erased, []);
      assert.deepEqual(flash.prepared, []);
      assert.deepEqual(flash.written, []);
    } finally {
      await session.close();
    }
  }
});

test('HM Pro checks the whole installed BL when both versions have the same BL sample', async t => {
  const pins = new Map();
  const primary = makeHmFixture('1.7.0', pins);
  const other = makeHmFixture('1.7.1', pins);
  useSyntheticAgent(t, pins);
  other.memory.copy(primary.memory, 0x3000, 0x3000, 0x23000);
  const flash = simulateHmFlash(primary.memory);
  const session = await connectLierda(downloadPort(null, { flash }));
  try {
    assert.equal(session.lierdaProfile.sdkVersion, '1.7.0');
    await assert.rejects(session.writeLierda(primary.firmware(), { saveBackup: assert.fail }), /BL.*不一致/);
    assert.deepEqual(flash.erased, []);
    assert.deepEqual(flash.prepared, []);
  } finally {
    await session.close();
  }
});
