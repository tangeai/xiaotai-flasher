import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { publishedBoards } from '../src/catalog.mjs';
import {
  parseEc718Package,
  validateEc718Agent,
  ec718AgentSize,
} from '../src/ec718-image.mjs';
import { createEc718LogDecoder } from '../src/ec718-log.mjs';
import { connectEc718, createEc718Protocol } from '../src/ec718.mjs';
import { prepareFirmware } from '../src/firmware.mjs';

const head = 0x54494d48;
const boot = 0x4f424d49;
const ap = 0x444b4249;
const le32 = (value) =>
  Buffer.from([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    value >>> 24,
  ]);

function makePackage() {
  const header = Buffer.alloc(0x1d8);
  header.write('bpkg', 8);
  header.write('pkgmode', 0x38);
  header.write('EC718PM_PRD', 0x190);
  let offset = header.length;
  const contents = [header];
  for (const [type, address] of [
    ['BL', 0x803000],
    ['AP', 0x882000],
    ['CP', 0x81e000],
  ]) {
    const meta = Buffer.alloc(364);
    const data = Buffer.from(type);
    meta.writeUInt32LE(address, 64);
    meta.writeUInt32LE(4096, 68);
    meta.writeUInt32LE(offset, 72);
    meta.writeUInt32LE(data.length, 76);
    meta.write(
      createHash('sha256').update(data).digest('hex').toUpperCase(),
      80,
    );
    meta.write(type, 336);
    contents.push(meta, data);
    offset += meta.length + data.length;
  }
  return Buffer.concat(contents);
}

test('checks Air780EPM partition identity, bounds, order and SHA-256', async () => {
  const valid = makePackage();
  const partitions = await parseEc718Package(valid);
  assert.deepEqual(
    partitions.map(({ type, address }) => [type, address]),
    [
      ['BL', 0],
      ['AP', 0x82000],
      ['CP', 0x1e000],
    ],
  );

  const wrongChip = Buffer.from(valid);
  wrongChip.write('EC718P_PRD\0', 0x190);
  await assert.rejects(parseEc718Package(wrongChip), /EC718PM_PRD/);
  const overlap = Buffer.from(valid);
  overlap.writeUInt32LE(0x803000, 0x1d8 + 366 + 64);
  await assert.rejects(parseEc718Package(overlap), /AP 分区的地址/);
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(parseEc718Package(corrupt), /CP 分区的 SHA-256/);
  await assert.rejects(
    parseEc718Package(valid.subarray(0, valid.length - 1)),
    /CP 分区的地址/,
  );
  await assert.rejects(
    parseEc718Package(Buffer.concat([valid, Buffer.from([1])])),
    /额外数据/,
  );
});

test('accepts online EC718 package and AgentBoot links without a local file', () => {
  const [board] = publishedBoards(
    {
      boards: [
        {
          slug: 'air780epm',
          model: 'Air780EPM',
          chip: 'EC718PM',
          releases: [
            {
              version: 'v1',
              status: 'published',
              bin_url: './core.binpkg',
              sha256: '0'.repeat(64),
              agent_url: './agent.bin',
            },
          ],
        },
      ],
    },
    'https://example.org/boards.json',
  );
  const firmware = prepareFirmware({
    origin: 'official',
    board,
    version: 'v1',
  });
  assert.equal(firmware.packageImage, true);
  assert.equal(firmware.release.agent_url, 'https://example.org/agent.bin');
  assert.throws(
    () =>
      prepareFirmware({
        origin: 'local',
        expectedChip: 'EC718PM',
        merged: new File(['foo'], 'firmware.bin'),
      }),
    /固件包/,
  );
});

const sync = (word) => ({ word });
const cmd = (id, reply, options) => ({ id, reply, ...options });
const select = (identifier) => [
  cmd(0x20),
  cmd(0x21, le32(identifier)),
  cmd(0x22),
];
const transfer = (size, checks) => [
  cmd(0x31, le32(size), { data: le32(size) }),
  cmd(0x32, undefined, { check: checks }),
  cmd(0x3a),
];

function simulatedProtocol(steps) {
  const pending = [...steps];
  const incoming = [];
  let mode;
  let disconnected = false;
  const writer = {
    async write(frame) {
      const step = pending.shift();
      assert.ok(step, 'all expected steps consumed');
      const bytes = Buffer.from(frame);
      let response;
      if (step.word) {
        assert.deepEqual(bytes, le32(step.word));
        mode = bytes[0];
        response = mode === 0 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
      } else {
        assert.equal(bytes[0], step.id);
        const length = bytes.readUIntLE(4, 3);
        const body = bytes.subarray(8, length + 8);
        if (step.data) assert.deepEqual(body, step.data);
        step.check?.(body);
        if (mode !== 0 || step.id === 0x32) {
          const plain = Buffer.from(bytes.subarray(0, length + 8));
          plain[7] = 0;
          const checksum =
            mode === 0 ? plain.reduce((a, b) => a + b, 0) : crc32(plain);
          assert.equal(bytes.readUInt32LE(length + 8), checksum);
        }
        const data = step.reply ?? Buffer.alloc(0);
        response = Buffer.concat([
          Buffer.from([
            step.id,
            bytes[1],
            bytes[2],
            bytes[3],
            step.status ?? 0,
            data.length,
          ]),
          data,
          Buffer.alloc(mode === 0 ? 0 : 4),
        ]);
      }
      if (step.disconnect) {
        disconnected = true;
        incoming.push(response.subarray(0, step.disconnect));
      } else {
        incoming.push(response.subarray(0, 3), response.subarray(3));
      }
    },
  };
  const reader = {
    async read() {
      const value = incoming.shift();
      if (!value && disconnected) return { done: true };
      assert.ok(value, 'mock has a response for the current step');
      return { done: false, value };
    },
  };
  return {
    ...createEc718Protocol(reader, writer),
    assertFinished: () => assert.deepEqual(pending, []),
  };
}

test('loads AgentBoot, writes split AP blocks, checks status and resets', async () => {
  const data = Buffer.alloc(0x10001, 0xef);
  const digest = createHash('sha256').update(data).digest();
  const agent = Buffer.of(3, 6, 9);
  const romSync = sync(0x2b02d300);
  const agentSync = sync(0x2b02d3aa);
  const lpcSync = sync(0x2b02d3cd);
  const device = simulatedProtocol([
    romSync,
    ...select(head),
    ...transfer(272, (header) => {
      assert.equal(header.readUInt32LE(64), boot);
      assert.equal(header.readUInt16LE(22), 0xa400);
    }),
    romSync,
    ...select(boot),
    ...transfer(agent.length, (bytes) => assert.deepEqual(bytes, agent)),
    lpcSync,
    cmd(0x42, undefined, { data: le32(ap) }),
    agentSync,
    agentSync,
    ...select(head),
    ...transfer(272, (header) => {
      assert.equal(header.readUInt32LE(64), ap);
      assert.equal(header.readUInt32LE(68), 0x82000);
      assert.deepEqual(header.subarray(96, 128), digest);
      const copy = Buffer.from(header);
      copy.fill(0, 32, 64);
      assert.deepEqual(
        header.subarray(32, 64),
        createHash('sha256').update(copy).digest(),
      );
    }),
    agentSync,
    ...select(ap),
    ...transfer(0x10000),
    agentSync,
    ...select(ap),
    ...transfer(1),
    cmd(0x44, le32(0)),
    lpcSync,
    cmd(0xaa, Buffer.from('ZzZzZzZz')),
  ]);
  await device.sync('rom');
  await device.loadAgent(agent);
  const transmitted = [];
  await device.burn(
    { identifier: ap, address: 0x82000, data, digest },
    (count) => transmitted.push(count),
  );
  assert.deepEqual(transmitted, [0x10000, 1]);
  await device.reset();
  device.assertFinished();
});

test('decodes split and escaped EC718 SOC log frames with string and integer arguments', () => {
  const bytes = Buffer.concat([
    le32(1357),
    Buffer.alloc(8),
    Buffer.from('I/main %.*s n=%d\0'),
    Buffer.alloc(3),
    le32(5),
    Buffer.from('x~}yz'),
    Buffer.alloc(3),
    le32(0xfffffff9),
  ]);
  const escaped = [0x7e];
  for (const byte of bytes) {
    if (byte === 0x7e || byte === 0x7d) escaped.push(0x7d, byte ^ 0x20);
    else escaped.push(byte);
  }
  escaped.push(0x7e);
  const decoder = createEc718LogDecoder();
  let logs = '';
  for (const byte of escaped) logs += decoder.decode([byte]);
  assert.equal(logs, '[1.357s] I/main x~}yz n=-7\n');
  assert.equal(decoder.decode([0x7e, 0, 0, 0x7e]), '');
});

test('rejects a corrupted AgentBoot even when the file size is correct', async () => {
  await assert.rejects(
    validateEc718Agent(new Uint8Array(ec718AgentSize)),
    /AgentBoot 校验失败/,
  );
});

test('rejects a running-mode USB port before opening the download connection', async () => {
  await assert.rejects(
    connectEc718({
      getInfo: () => ({ usbVendorId: 0x19d1, usbProductId: 1 }),
      open: () => assert.fail('must not open a runtime USB port for flashing'),
    }),
    /USB BOOT 下载串口/,
  );
});

test('stops before sending payload when the device refuses to select a partition', async () => {
  const device = simulatedProtocol([
    sync(0x2b02d3cd),
    cmd(0x42, le32(0), { status: 3, disconnect: 6 }),
  ]);
  await assert.rejects(
    device.burn({ identifier: ap }, () => assert.fail('no payload was sent')),
    /命令 0x42.*状态 3/,
  );
  device.assertFinished();
});

test('stops when the device returns a different image type or a zero transfer length', async () => {
  const wrongImage = simulatedProtocol([
    sync(0x2b02d300),
    cmd(0x20),
    cmd(0x21, le32(ap)),
  ]);
  await wrongImage.sync('rom');
  await assert.rejects(wrongImage.loadAgent(Buffer.of(7)), /镜像类型/);
  wrongImage.assertFinished();

  const zeroLength = simulatedProtocol([
    sync(0x2b02d300),
    ...select(head),
    cmd(0x31, le32(0), { data: le32(272) }),
  ]);
  await zeroLength.sync('rom');
  await assert.rejects(zeroLength.loadAgent(Buffer.of(7)), /无效的传输长度/);
  zeroLength.assertFinished();
});

test('fails on disconnect in the middle of a response', async () => {
  const device = simulatedProtocol([
    sync(0x2b02d3cd),
    cmd(0x42, undefined, { disconnect: 3 }),
  ]);
  await assert.rejects(
    device.burn({ identifier: ap }, () => assert.fail('no payload was sent')),
    /下载串口已断开/,
  );
  device.assertFinished();
});

test('rejects a nonzero partition verification result and an invalid reset reply', async () => {
  const data = Buffer.of(7);
  const digest = createHash('sha256').update(data).digest();
  const device = simulatedProtocol([
    sync(0x2b02d3cd),
    cmd(0x42, undefined, { data: le32(ap) }),
    sync(0x2b02d3aa),
    sync(0x2b02d3aa),
    ...select(head),
    ...transfer(272),
    sync(0x2b02d3aa),
    ...select(ap),
    ...transfer(1),
    cmd(0x44, le32(12)),
  ]);
  await assert.rejects(
    device.burn(
      { identifier: ap, address: 0x82000, type: 'AP', data, digest },
      () => {},
    ),
    /AP 分区写入校验失败/,
  );
  device.assertFinished();

  const invalidReset = simulatedProtocol([
    sync(0x2b02d3cd),
    cmd(0xaa, Buffer.from('wrong')),
  ]);
  await assert.rejects(invalidReset.reset(), /未收到 EC718 复位确认/);
  invalidReset.assertFinished();
});

test('retries a late split ROM echo without creating a second serial read', async () => {
  let writes = 0;
  let reads = 0;
  let pendingResponse;
  const protocol = createEc718Protocol(
    {
      read() {
        reads += 1;
        if (reads === 2)
          return Promise.resolve({ value: Buffer.from([0x2b, 0]) });
        assert.equal(reads, 1);
        return new Promise((resolve) => {
          pendingResponse = resolve;
        });
      },
    },
    {
      async write() {
        writes += 1;
        if (writes === 2)
          pendingResponse({ value: Buffer.from([0xff, 0, 0xd3, 2]) });
      },
    },
  );
  await protocol.sync('rom');
  assert.equal(writes, 2);
  assert.equal(reads, 2);
});

test('SOC log decoder recovers after an oversize frame and a dangling escape', () => {
  const decoder = createEc718LogDecoder();
  const validLine = Buffer.concat([
    le32(0),
    Buffer.alloc(8),
    Buffer.from('I/main 日志恢复\0'),
  ]);
  assert.equal(
    decoder.decode(
      Buffer.concat([
        Buffer.of(0x7e),
        Buffer.alloc(8193, 1),
        Buffer.of(0x7e),
        validLine,
        Buffer.of(0x7d, 0x7e),
        validLine,
        Buffer.of(0x7e),
      ]),
    ),
    '[0.000s] I/main 日志恢复\n',
  );
});
