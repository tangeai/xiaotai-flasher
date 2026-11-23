import test from 'node:test';
import assert from 'node:assert/strict';
import { startSerialRecording } from '../src/serial-recording.mjs';

// Node 20 does not expose the browser Web Locks API.
if (!globalThis.navigator) globalThis.navigator = {};
if (!navigator.locks) {
  Object.defineProperty(navigator, 'locks', { value: { request: (_name, task) => task() } });
}

function memoryDirectory() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
        files.set(name, '');
      }
      return {
        async getFile() { return { size: Buffer.byteLength(files.get(name)) }; },
        async createWritable({ keepExistingData }) {
          let content = keepExistingData ? files.get(name) : '';
          return {
            seek(offset) { assert.equal(offset, Buffer.byteLength(content)); },
            async write(blob) { content += await blob.text(); },
            async close() { files.set(name, content); },
            async abort() {},
          };
        },
      };
    },
  };
}

test('checkpoints append UTF-8 text and rotate files within one session', async () => {
  const directory = memoryDirectory();
  const recording = startSerialRecording(directory, assert.fail);
  const block = '测'.repeat(256 * 1024);
  for (let i = 0; i < 14; i++) await recording.append(block);
  recording.append('结束');
  assert.equal(await recording.stop(), true);
  const entries = [...directory.files];
  assert.equal(entries.length, 2);
  assert.match(entries[0][0], /^\d{14}-001\.log$/);
  assert.equal(entries[1][0], entries[0][0].replace('001.log', '002.log'));
  assert.equal(entries.map(([, data]) => data).join(''), block.repeat(14) + '结束');
});

test('timer commits sparse output and stop awaits an in-flight write', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = memoryDirectory();
  const recording = startSerialRecording(directory, assert.fail);
  recording.append('first');
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...directory.files.values()], ['first']);
  recording.append(' second');
  t.mock.timers.tick(30000);
  recording.append(' third');
  await recording.stop();
  assert.deepEqual([...directory.files.values()], ['first second third']);
});

test('reports disk failure once and stops further writes', async () => {
  const errors = [];
  const recording = startSerialRecording({
    getFileHandle() { throw new Error('disk full'); },
  }, error => errors.push(error.message));
  recording.append('x'.repeat(256 * 1024));
  recording.append('more');
  assert.equal(await recording.stop(), false);
  assert.deepEqual(errors, ['disk full']);
});

test('local start time names each part and existing files are preserved', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 23, 9, 5, 8) });
  const directory = memoryDirectory();
  const lookup = directory.getFileHandle;
  directory.getFileHandle = (name, options) => {
    if (name.endsWith('-002.log')) throw new DOMException('Directory', 'TypeMismatchError');
    return lookup(name, options);
  };
  directory.files.set('20261123090508-001.log', 'earlier session');
  const recording = startSerialRecording(directory, assert.fail);
  recording.append('new session');
  await recording.stop();
  assert.deepEqual([...directory.files], [
    ['20261123090508-001.log', 'earlier session'],
    ['20261123090508-003.log', 'new session'],
  ]);
});

test('slow disk drains accepted chunks in order and reports overflow once', async () => {
  const directory = memoryDirectory();
  const lookup = directory.getFileHandle;
  let resume;
  const blocked = new Promise(resolve => { resume = resolve; });
  directory.getFileHandle = async (...args) => {
    await blocked;
    return lookup(...args);
  };
  const errors = [];
  const recording = startSerialRecording(directory, error => errors.push(error.message));
  const blocks = Array.from({ length: 8 }, (_, index) => String(index).repeat(256 * 1024));
  for (const block of blocks) recording.append(block);
  recording.append('overflow');
  recording.append('after overflow');
  assert.equal(errors.length, 1);
  resume();
  assert.equal(await recording.stop(), false);
  assert.deepEqual([...directory.files.values()], [blocks.join('')]);
});

test('a failed file close aborts the checkpoint and preserves earlier data', async () => {
  const directory = memoryDirectory();
  const lookup = directory.getFileHandle;
  let commits = 0;
  let aborts = 0;
  directory.getFileHandle = async (...args) => {
    const file = await lookup(...args);
    return {
      ...file,
      async createWritable(options) {
        const stream = await file.createWritable(options);
        if (++commits === 2) {
          stream.close = async () => { throw new Error('disk full'); };
          stream.abort = async () => { aborts++; };
        }
        return stream;
      },
    };
  };
  const errors = [];
  const recording = startSerialRecording(directory, error => errors.push(error.message));
  const block = 'a'.repeat(256 * 1024);
  await recording.append(block);
  recording.append('last batch');
  assert.equal(await recording.stop(), false);
  assert.deepEqual([...directory.files.values()], [block]);
  assert.deepEqual(errors, ['disk full']);
  assert.equal(aborts, 1);
});

test('a changed file is preserved when recording resumes at the next checkpoint', async () => {
  const directory = memoryDirectory();
  const errors = [];
  const recording = startSerialRecording(directory, error => errors.push(error.message));
  await recording.append('a'.repeat(256 * 1024));
  const [name] = directory.files.keys();
  directory.files.set(name, 'edited externally');
  recording.append('later serial output');
  assert.equal(await recording.stop(), false);
  assert.deepEqual([...directory.files.values()], ['edited externally']);
  assert.match(errors[0], /文件大小已被更改/);
});

test('queued checkpoints after a disk error report once and two stop calls agree', async () => {
  let attempts = 0;
  const errors = [];
  const recording = startSerialRecording({
    async getFileHandle() {
      attempts++;
      throw new DOMException('permission revoked', 'NotAllowedError');
    },
  }, error => errors.push(error.name));
  for (let i = 0; i < 5; i++) recording.append('x'.repeat(256 * 1024));
  const results = await Promise.all([recording.stop(), recording.stop()]);
  assert.deepEqual(results, [false, false]);
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ['NotAllowedError']);
});
