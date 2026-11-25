import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDownloadPort,
  isLierdaAtPort,
  lierdaAtFilter,
  lierdaDownloadFilter,
  requestLierdaDownloadMode,
  selectLierdaDownloadPort,
  selectLierdaPort,
  waitForLierdaDownloadPort,
} from '../src/lierda-serial.mjs';

const atProbe = 'AT\r\n';
const atIdentity = 'ATI\r\n';
const enterDownload = 'AT+ECRST=delay,599\r\n';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function portInfo(info) {
  return { connected: true, getInfo: () => info };
}

function atPort({ info = lierdaAtFilter, initial = [], probe = [], identity = [], reboot = [], disconnect = false } = {}) {
  let readStream;
  let writeStream;
  let opened = false;
  let closed = false;
  const sent = [];
  return {
    ...portInfo(info), sent,
    get opened() { return opened; },
    get closed() { return closed; },
    get readable() { return closed ? null : readStream; },
    get writable() { return closed ? null : writeStream; },
    async open(settings) {
      assert.deepEqual(settings, { baudRate: 115200, dataBits: 8, stopBits: 1,
        parity: 'none', flowControl: 'none' });
      opened = true;
      closed = false;
      let receiver;
      readStream = new ReadableStream({
        start(controller) {
          receiver = controller;
          for (const part of initial) receiver.enqueue(encoder.encode(part));
        },
      });
      writeStream = new WritableStream({
        write: (buffer) => {
          const command = decoder.decode(buffer);
          assert.ok([atProbe, atIdentity, enterDownload].includes(command));
          sent.push(command);
          const result = command === atProbe ? probe : command === atIdentity ? identity : reboot;
          for (const part of result) receiver.enqueue(encoder.encode(part));
          if (command === enterDownload && disconnect) {
            this.connected = false;
            receiver.close();
          }
        },
      });
    },
    async close() {
      assert.equal(readStream.locked, false);
      assert.equal(writeStream.locked, false);
      closed = true;
    },
  };
}

test('only accepts the known Lierda AT/runtime and QDLoader USB identities', () => {
  assert.deepEqual(lierdaAtFilter, { usbVendorId: 0x3505 });
  assert.equal(isLierdaAtPort(portInfo(lierdaAtFilter)), true);
  assert.equal(isLierdaAtPort(portInfo({ usbVendorId: 0x3505, usbProductId: 0x0003 })), true);
  assert.equal(isLierdaAtPort(portInfo({ usbVendorId: 0x3505, usbProductId: 0x0001 })), false);
  assert.equal(isLierdaAtPort(portInfo(lierdaDownloadFilter)), false);
  assert.equal(isDownloadPort(portInfo(lierdaDownloadFilter)), true);
  assert.equal(isDownloadPort(portInfo({ usbVendorId: 0x17d1 })), false);
});

test('reuses exactly one known permission and ignores disconnected and unrelated ports', async () => {
  const at = portInfo(lierdaAtFilter);
  const stale = { ...portInfo(lierdaDownloadFilter), connected: false };
  const serial = {
    getPorts: async () => [at, stale, portInfo({ usbVendorId: 0x2341 })],
    requestPort() { assert.fail('A known port does not need a chooser'); },
  };
  assert.equal(await selectLierdaPort(serial), at);

  const qdloader = portInfo(lierdaDownloadFilter);
  serial.getPorts = async () => [at, qdloader];
  assert.equal(await selectLierdaPort(serial, { downloadOnly: true }), qdloader);
});

test('opens the native chooser on first use, ambiguity or explicit change', async () => {
  const at = portInfo(lierdaAtFilter);
  const qdloader = portInfo(lierdaDownloadFilter);
  const chooserCalls = [];
  const serial = {
    getPorts: async () => [],
    async requestPort(...options) {
      chooserCalls.push(options);
      return at;
    },
  };
  assert.equal(await selectLierdaPort(serial), at);
  serial.getPorts = async () => [at, qdloader];
  assert.equal(await selectLierdaPort(serial), at);
  serial.getPorts = async () => [at];
  assert.equal(await selectLierdaPort(serial, { chooseOther: true }), at);
  assert.equal(await selectLierdaPort(serial, { downloadOnly: true }), at);
  assert.deepEqual(chooserCalls, [[], [], [], [{ filters: [lierdaDownloadFilter] }]]);
});

test('recognizes the Lierda AT interface from already granted ports that share USB IDs', async () => {
  const trueAt = atPort({ identity: ['Li', 'erda\r\nNT26F9D0\r\nRevision: V1\r\nO', 'K\r\n'] });
  const diagnostic = atPort({ identity: ['OK\r\n'] });
  const uart = atPort({ identity: ['Lierda log NT26F9D0\r\nOK\r\n'] });
  const serial = {
    getPorts: async () => [diagnostic, uart, trueAt],
    requestPort() { assert.fail('Unique Lierda identity should not prompt'); },
  };
  assert.equal(await selectLierdaPort(serial), trueAt);
  for (const port of [trueAt, diagnostic, uart]) {
    assert.deepEqual(port.sent, [atIdentity]);
    assert.equal(port.closed, true);
  }
});

test('asks when several granted ports identify as AT or another port cannot be checked', async () => {
  const identity = ['Lierda\r\nNT26F9D0\r\nOK\r\n'];
  const selected = portInfo(lierdaAtFilter);
  for (const candidates of [
    [atPort({ identity }), atPort({ identity })],
    [atPort({ identity }), { ...portInfo(lierdaAtFilter), async open() { throw new Error('Port busy'); } }],
  ]) {
    const serial = { getPorts: async () => candidates, requestPort: async () => selected };
    assert.equal(await selectLierdaPort(serial), selected);
    assert.deepEqual(candidates[0].sent, [atIdentity]);
    assert.equal(candidates[0].closed, true);
  }
});

test('gives a briefly missing granted port a chance to enumerate before prompting', async () => {
  const port = portInfo(lierdaAtFilter);
  let calls = 0;
  const serial = {
    getPorts: async () => calls++ === 0 ? [] : [port],
    requestPort() { assert.fail('The granted port appeared before the chooser'); },
  };
  assert.equal(await selectLierdaPort(serial), port);
});

test('validates the selected port before sending the exact one-shot reboot', async () => {
  const port = atPort({ probe: ['AT\r\nO', 'K\r', '\n'], reboot: ['\r\nOK\r\n'] });
  const result = await requestLierdaDownloadMode(port, { timeoutMs: 100 });
  assert.deepEqual(result, { acknowledged: true });
  assert.deepEqual(port.sent, [atProbe, enterDownload]);
  assert.equal(port.closed, true);
});

test('a mismatched USB port never opens or sends data', async () => {
  const port = atPort({ info: { usbVendorId: 0x3505, usbProductId: 0x99 } });
  await assert.rejects(requestLierdaDownloadMode(port), /Lierda At Port/);
  assert.equal(port.opened, false);
  assert.deepEqual(port.sent, []);
});

test('stale OK and OK embedded in a log line cannot authorize the reboot', async () => {
  const port = atPort({ initial: ['OK\r\n'], probe: ['some log says OK\r\n'] });
  await assert.rejects(requestLierdaDownloadMode(port, { timeoutMs: 25 }), /AT 应答超时/);
  assert.deepEqual(port.sent, [atProbe]);
  assert.equal(port.closed, true);
});

test('an AT error stops before sending the reboot', async () => {
  const port = atPort({ probe: ['\r\n+CME ERROR: 3\r\n'] });
  await assert.rejects(requestLierdaDownloadMode(port, { timeoutMs: 100 }), /AT 校验失败/);
  assert.deepEqual(port.sent, [atProbe]);
  assert.equal(port.closed, true);
});

test('a rejected reboot is not repeated', async () => {
  const port = atPort({ probe: ['OK\r\n'], reboot: ['ERROR\r\n'] });
  await assert.rejects(requestLierdaDownloadMode(port, { timeoutMs: 100 }), /拒绝进入下载模式/);
  assert.deepEqual(port.sent, [atProbe, enterDownload]);
  assert.equal(port.closed, true);
});

test('accepts a USB disconnect before the reboot reply and releases both locks', async () => {
  const port = atPort({ probe: ['OK\r\n'], disconnect: true });
  const result = await requestLierdaDownloadMode(port, { timeoutMs: 100 });
  assert.deepEqual(result, { acknowledged: false });
  assert.deepEqual(port.sent, [atProbe, enterDownload]);
  assert.equal(port.closed, true);
});

test('an abort between the AT probe and the reboot releases the port without resetting', async () => {
  const port = atPort({ probe: ['OK\r\n'] });
  const abort = new AbortController();
  await assert.rejects(requestLierdaDownloadMode(port, {
    signal: abort.signal,
    timeoutMs: 100,
    log: () => abort.abort(new Error('user canceled')),
  }), /user canceled/);
  assert.deepEqual(port.sent, [atProbe]);
  assert.equal(port.closed, true);
});

test('waits until the selected AT port has physically disconnected', async () => {
  const at = portInfo(lierdaAtFilter);
  const qdloader = portInfo(lierdaDownloadFilter);
  let enumerations = 0;
  const serial = {
    async getPorts() {
      if (enumerations++ === 0) return [qdloader];
      // A missing permission list alone is not enough on an API with connected.
      at.connected = false;
      return [qdloader];
    },
  };
  assert.equal(await waitForLierdaDownloadPort(serial, { atPort: at, timeoutMs: 400 }), qdloader);
  assert.equal(enumerations, 2);
});

test('automatically uses an authorized QDLoader that appears after a slow re-enumeration', async () => {
  const at = portInfo(lierdaAtFilter);
  const qdloader = portInfo(lierdaDownloadFilter);
  const readyAt = performance.now() + 3050;
  const serial = {
    async getPorts() {
      if (performance.now() < readyAt) return [at];
      at.connected = false;
      return [qdloader];
    },
  };
  assert.equal(await waitForLierdaDownloadPort(serial, { atPort: at }), qdloader);
});

test('never reuses a QDLoader present before transition and returns null for missing permission', async () => {
  const old = portInfo(lierdaDownloadFilter);
  assert.equal(await waitForLierdaDownloadPort({ getPorts: async () => [old] }, {
    previousPorts: [old], timeoutMs: 25,
  }), null);
  assert.equal(await waitForLierdaDownloadPort({ getPorts: async () => [] }, { timeoutMs: 25 }), null);
});

test('the second click opens a filtered chooser and rejects a download port from before the switch', async () => {
  const at = { ...portInfo(lierdaAtFilter), connected: false };
  const old = portInfo(lierdaDownloadFilter);
  const newPort = portInfo(lierdaDownloadFilter);
  const handoff = { atPort: at, previousPorts: [old] };
  const selections = [old, newPort];
  const serial = {
    getPorts: async () => [old],
    async requestPort(options) {
      assert.deepEqual(options, { filters: [lierdaDownloadFilter] });
      return selections.shift();
    },
  };

  await assert.rejects(selectLierdaDownloadPort(serial, handoff), /切换前已连接/);
  assert.equal(await selectLierdaDownloadPort(serial, handoff), newPort);
  assert.deepEqual(selections, []);
});

test('a sole authorized new QDLoader is unambiguous even when another download port was already connected', async () => {
  const at = { ...portInfo(lierdaAtFilter), connected: false };
  const old = portInfo(lierdaDownloadFilter);
  const newPort = portInfo(lierdaDownloadFilter);
  const handoff = { atPort: at, previousPorts: [old] };
  const serial = {
    getPorts: async () => [old, newPort],
    requestPort() { assert.fail('A single new port already has permission'); },
  };

  assert.equal(await waitForLierdaDownloadPort(serial, handoff), newPort);
  assert.equal(await selectLierdaDownloadPort(serial, handoff), newPort);
});

test('requests a choice when a previous QDLoader disappears during the AT handoff', async () => {
  const at = { ...portInfo(lierdaAtFilter), connected: false };
  const old = { ...portInfo(lierdaDownloadFilter), connected: false };
  const reconnected = portInfo(lierdaDownloadFilter);
  let chooserCalls = 0;
  const serial = {
    getPorts: async () => [reconnected],
    async requestPort() {
      chooserCalls++;
      return reconnected;
    },
  };
  const handoff = { atPort: at, previousPorts: [old] };
  assert.equal(await waitForLierdaDownloadPort(serial, handoff), null);
  assert.equal(await selectLierdaDownloadPort(serial, handoff), reconnected);
  assert.equal(chooserCalls, 1);
});

test('an explicitly selected download port still waits for the original AT interface to disconnect', async () => {
  const at = portInfo(lierdaAtFilter);
  const newPort = portInfo(lierdaDownloadFilter);
  const serial = {
    getPorts: async () => [at],
    requestPort: async () => newPort,
  };
  await assert.rejects(selectLierdaDownloadPort(serial, { atPort: at, previousPorts: [at] }), /AT 串口尚未断开/);
});

test('rejects multiple permissioned QDLoader candidates rather than choosing one', async () => {
  const serial = { getPorts: async () => [portInfo(lierdaDownloadFilter), portInfo(lierdaDownloadFilter)] };
  await assert.rejects(waitForLierdaDownloadPort(serial), /多个 QDLoader/);
});
