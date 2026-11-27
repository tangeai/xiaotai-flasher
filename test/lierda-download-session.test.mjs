import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { downloadPort, useSyntheticAgent } from './fixtures/lierda-port.mjs';
import { connectLierda } from '../src/lierda.mjs';
import { getLierdaFlashPlan, getLierdaHardwareProfile, matchLierdaDeviceLayout } from '../src/lierda-package.mjs';
import { parseLierdaBaudrate, USB_BAUD } from '../src/lierda-serial.mjs';
import { makeHmFixture, makePmFixture, populatePmSdkEntry, simulateHmFlash } from './fixtures/lierda-hm.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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

test('PM handshake identifies the installed Lite or Pro application independently of the selected model', async t => {
  const pm = getLierdaHardwareProfile('lite');
  const pins = new Map();
  const memory = Buffer.alloc(pm.size, 0xff);
  for (const [index, image] of pm.baseImages.entries()) {
    const offset = image.address + (image.role === 'BL' ? 0x100 : 0);
    const sample = memory.subarray(offset, offset + 240);
    sample.fill(index);
    pins.set(createHash('sha256').update(sample).digest('hex'), image.sampleSha);
  }
  useSyntheticAgent(t, pins);
  const cases = [
    ['pro-pm', 'lite', '617070304961aa001860aa003061aa0000c03b0000800200'],
    ['lite', 'pro-pm', '617070305161aa001860aa003861aa000010370000300700'],
    ['lite', 'pro-pm', '617070305161aa001860aa003861aa0000c03b0000800200'],
    [null, 'pro-pm', '617070304961aa001860aa003061aa0000c03b0000800200'],
    [null, 'pro-pm', 'ff'.repeat(24)],
    [null, 'lite', '617070304961aa001860aa003061aa0000c03b0000300700'],
  ];
  for (const [expected, selected, header] of cases) {
    memory.fill(0xff, pm.app.address, pm.app.address + 0x3100);
    Buffer.from(header, 'hex').copy(memory, pm.app.address);
    if (expected) populatePmSdkEntry(memory, pm.app.address, expected);
    const flash = simulateHmFlash(memory);
    const session = await connectLierda(downloadPort(null, { flash }), { model: selected });
    try {
      assert.equal(session.lierdaModel, expected);
      if (expected) {
        assert.equal(session.chip, 'EC718PM');
        assert.equal(session.capacity, 0x400000);
        assert.equal(session.lierdaCompatibilityIssue, '');
        if (expected === 'pro-pm') {
          assert.equal(getLierdaFlashPlan(session.lierdaProfile, session.lierdaProfile).mode, 'pm-pro');
        }
      } else {
        assert.match(session.lierdaCompatibilityIssue, /Lite.*Pro/);
        await assert.rejects(session.writeLierda(null, { saveBackup: assert.fail }), /Lite.*Pro/);
      }
      assert.deepEqual(flash.erased, []);
      assert.deepEqual(flash.written, []);
    } finally {
      await session.close();
    }
  }
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
    const result = await session.writeLierda(installed.firmware(), { saveBackup: saveFlashBackup(flash, before) });
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

function saveFlashBackup(flash, before) {
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
        allowReinstall: true, saveBackup: saveFlashBackup(flash, before),
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
      allowReinstall: true, saveBackup: saveFlashBackup(flash, before),
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

async function pmProSession(t, onImageWritten) {
  const profile = getLierdaHardwareProfile('pro-pm');
  const pins = new Map();
  const fixture = makePmFixture(profile, pins);
  useSyntheticAgent(t, pins);
  const before = Buffer.concat([fixture.memory, fixture.external]);
  const flash = simulateHmFlash(fixture.memory, { external: fixture.external, onImageWritten });
  const port = downloadPort(null, { flash });
  const session = await connectLierda(port, { model: 'pro-pm' });
  t.after(() => session.close());
  assert.equal(session.lierdaModel, 'pro-pm', session.lierdaCompatibilityIssue);
  return { ...fixture, profile, before, flash, port, session };
}

test('reconnect to the same running PM Pro agent rechecks the board without loading RAM or writing Flash', async t => {
  const { session, port, flash, before, memory, external } = await pmProSession(t);
  const expectedReads = [...port.reads];
  for (const address of [0x803100, 0x8be000, 0x81e000, 0xaa6000, 0xaa6148, 0xaa9000]) {
    assert.ok(expectedReads.includes(address), 'read ' + address.toString(16));
  }
  assert.equal(port.agentBauds.length, 1);
  await session.close();
  const lastCommand = port.commands.length;
  const readCount = port.reads.length;
  const reconnected = await connectLierda(port, { model: 'lite' });
  t.after(() => reconnected.close());
  assert.equal(reconnected.lierdaModel, 'pro-pm', reconnected.lierdaCompatibilityIssue);
  const warmReads = port.reads.slice(readCount);
  assert.ok(warmReads.includes(0x401000));
  assert.deepEqual(warmReads.filter(address => address >= 0x800000), [0xe0000000, ...expectedReads]);
  assert.ok(!port.commands.slice(lastCommand).includes(0x32), 'does not transfer a new agent');
  assert.equal(port.agentBauds.length, 1);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.deepEqual(flash.externalWritten, []);
  assert.ok(before.equals(Buffer.concat([memory, external])));
});

test('a resident USB agent only admits the same chip revision as a cold connection', async t => {
  const { session, port, flash } = await pmProSession(t);
  await session.close();
  port.residentRomReply = Buffer.from([0x2b, 0x02, 0xd3, 0xee]);
  const record = Buffer.from(port.chipInfo);
  for (const [family, revision, length, expected] of [
    ['ec718m2', 1, 32, /ROM 0000000203030000/],
    ['ec718m2', 2, 32, /ROM 0000000303030000/],
    ['ec718m2', 0x100, 32, /无法确认.*ROM/],
    ['ec718m3', 0, 32, /无法确认.*ROM/],
    ['ec718m2x', 0, 32, /无法确认.*ROM/],
    ['ec718m2', 0, 24, /回读长度不符/],
  ]) {
    port.chipInfo = Buffer.from(record.subarray(0, length));
    port.chipInfo.write(family);
    port.chipInfo.writeUInt32LE(revision, 16);
    const readStart = port.reads.length;
    const cmdStart = port.commands.length;
    await assert.rejects(connectLierda(port), expected);
    assert.deepEqual(port.reads.slice(readStart).filter(address => address >= 0x800000), [0xe0000000]);
    assert.ok(port.commands.slice(cmdStart).every(command => command === 0x21));
    assert.equal(port.readable, null);
  }
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.deepEqual(flash.externalWritten, []);
});

test('a warm LPC echo cannot authorize writing when the board identity has changed', async t => {
  const { session, port, flash, memory, firmware } = await pmProSession(t);
  await session.close();
  memory[0x3100] ^= 1;
  const lastCommand = port.commands.length;
  const reconnected = await connectLierda(port, { model: 'pro-pm' });
  t.after(() => reconnected.close());
  assert.equal(reconnected.lierdaModel, null);
  assert.match(reconnected.lierdaCompatibilityIssue, /BL/);
  await assert.rejects(reconnected.writeLierda(firmware, { saveBackup: assert.fail }), /BL/);
  await assert.rejects(reconnected.reset(), /请先完成/);
  assert.ok(!port.commands.slice(lastCommand).includes(0x32));
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.deepEqual(flash.externalWritten, []);
});

test('a modified RAM agent cannot resume a PM Pro session even when the previous board was recognized', async t => {
  const { session, port, flash } = await pmProSession(t);
  await session.close();
  const lastCommand = port.commands.length;
  const readCount = port.reads.length;
  port.ramAgent[port.ramAgent.length - 1] ^= 1;
  await assert.rejects(connectLierda(port), /AgentBoot|下载程序/);
  assert.ok(!port.reads.slice(readCount).some(address => address >= 0x800000));
  assert.ok(!port.commands.slice(lastCommand).includes(0x32));
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.written, []);
  assert.deepEqual(flash.externalWritten, []);
  assert.equal(port.readable, null);
});

test('a changed Lite AI application identity blocks internal and external writes before backup', async t => {
  const pins = new Map();
  const compact = getLierdaHardwareProfile('lite');
  const header = Buffer.from('617070305161aa001860aa003861aa0000c03b0000800200', 'hex');
  const shared = matchLierdaDeviceLayout(compact, header, 'lite');
  const installed = makePmFixture(shared, pins);
  useSyntheticAgent(t, pins);
  const flash = simulateHmFlash(installed.memory);
  const port = downloadPort(null, { flash });
  const session = await connectLierda(port);
  t.after(() => session.close());
  assert.equal(session.lierdaProfile, shared);
  populatePmSdkEntry(installed.memory, shared.app.address, 'pro-pm');
  await assert.rejects(session.writeLierda(installed.firmware, { saveBackup: assert.fail }), /应用标识/);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.ok(!port.commands.includes(0xe0));
});

for (const direction of ['from shared', 'to shared']) {
  test('PM Lite full internal update ' + direction + ' layout never accesses SPI1', async t => {
    const pins = new Map();
    const compact = getLierdaHardwareProfile('lite');
    const shared = matchLierdaDeviceLayout(compact, Buffer.from('617070305161aa001860aa003861aa0000c03b0000800200', 'hex'), 'lite');
    const [source, target] = direction === 'from shared' ? [shared, compact] : [compact, shared];
    const installed = makePmFixture(source, pins);
    const firmware = makePmFixture(target, pins);
    const before = Buffer.from(installed.memory);
    useSyntheticAgent(t, pins);
    const flash = simulateHmFlash(installed.memory);
    const port = downloadPort(null, { flash });
    const session = await connectLierda(port, { model: 'pro-pm' });
    t.after(() => session.close());
    assert.equal(session.lierdaProfile, source);
    const result = await session.writeLierda(firmware.firmware, { saveBackup: saveFlashBackup(flash, before) });
    assert.deepEqual(result.verifiedImages.map(image => image.role), ['BL', 'AP', 'CP', 'APP']);
    assert.ok(firmware.app.equals(installed.memory.subarray(target.app.address, target.app.address + firmware.app.length)));
    for (const { start, end } of source.preservedRanges) {
      assert.ok(before.subarray(start, end).equals(installed.memory.subarray(start, end)));
    }
    assert.ok(!port.commands.includes(0xe0));
    assert.ok(!port.commands.includes(0x24));
    await session.close();
    const reconnected = await connectLierda(port, { model: 'pro-pm' });
    t.after(() => reconnected.close());
    assert.equal(reconnected.lierdaProfile, target, 'warm reconnect identifies the newly flashed Lite layout');
    assert.equal(port.agentBauds.length, 1);
  });
}

test('HM Pro reopens a running agent and checks SDK and upper internal Flash even with PM selected', async t => {
  const pins = new Map();
  const installed = makeHmFixture('1.7.0', pins);
  useSyntheticAgent(t, pins);
  const flash = simulateHmFlash(installed.memory);
  const port = downloadPort(null, { flash });
  const cold = await connectLierda(port);
  assert.equal(cold.lierdaModel, 'pro-f9');
  await cold.close();
  const readCount = port.reads.length;
  const warm = await connectLierda(port, { model: 'lite' });
  t.after(() => warm.close());
  assert.equal(warm.lierdaProfile, cold.lierdaProfile);
  assert.ok(port.reads.slice(readCount).includes(0xc00000));
  assert.equal(port.agentBauds.length, 1);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.erased, []);
});

test('PM Pro verifies the complete external resources and internal APP from one BINPKG', async t => {
  const { memory, external, app, resource, profile, before, flash, port, firmware, session } = await pmProSession(t);
  const result = await session.writeLierda(firmware, { saveBackup: saveFlashBackup(flash, before) });
  const expected = Buffer.from(before.subarray(0, memory.length));
  expected.fill(0xff, profile.app.address, profile.app.fsStart);
  app.copy(expected, profile.app.address);
  assert.ok(memory.equals(expected), 'all internal bytes outside the APP partition are preserved');
  assert.ok(external.equals(resource), 'all 4 MiB of SPI1 contain the published resource image');
  assert.deepEqual(result.verifiedImages, [['EXT', resource], ['APP', app]].map(([role, data]) => ({
    role, length: data.length, sha256: createHash('sha256').update(data).digest('hex'),
  })));
  assert.ok(!port.commands.includes(0xaa));
  await session.reset();
  assert.equal(port.commands.at(-1), 0xaa);
});

test('PM Pro external readback mismatch leaves internal Flash intact and prevents reset', async t => {
  const { memory, external, before, firmware, flash, port, session } = await pmProSession(t, (_id, target) => {
    if (target === external) target[target.length - 1] ^= 1;
  });
  await assert.rejects(session.writeLierda(firmware, { saveBackup: saveFlashBackup(flash, before) }),
    /SPI1.*SHA-256/);
  assert.ok(flash.externalWritten.length);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.ok(memory.equals(before.subarray(0, memory.length)));
  await assert.rejects(session.reset(), /请先完成/);
  assert.ok(!port.commands.includes(0xaa));
});

test('PM Pro rejects damaged BL or AP boot headers before accessing external storage', async t => {
  const { memory, firmware, flash, port, session } = await pmProSession(t);
  for (const address of [0, 0x1000 + 96]) {
    memory[address] ^= 1;
    await assert.rejects(session.writeLierda(firmware, { saveBackup: assert.fail }), /PM Pro 底包/);
    memory[address] ^= 1;
  }
  assert.ok(!port.commands.includes(0x24), 'no SPI1 block reads');
  assert.deepEqual(flash.externalWritten, []);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.written, []);
  await assert.rejects(session.reset(), /请先完成/);
  assert.ok(!port.commands.includes(0xaa));
});

test('PM Pro cannot write to either Flash or reset if saving the complete backup fails', async t => {
  const { memory, external, before, firmware, flash, port, session } = await pmProSession(t);
  const saveBackup = async bytes => {
    assert.ok(before.equals(bytes), 'save receives full internal and external contents');
    throw new Error('backup storage is full');
  };
  await assert.rejects(session.writeLierda(firmware, { saveBackup }), /backup storage is full/);
  assert.deepEqual(flash.externalWritten, []);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.prepared, []);
  assert.deepEqual(flash.written, []);
  assert.ok(Buffer.concat([memory, external]).equals(before));
  await assert.rejects(session.reset(), /请先完成/);
  assert.ok(!port.commands.includes(0xaa));
});
