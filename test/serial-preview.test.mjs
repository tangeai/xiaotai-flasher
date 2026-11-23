import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialPreview, previewOffset, timestampedPreview } from '../src/serial-preview.mjs';

const first = new Date(2026, 10, 23, 9, 5, 8, 7).getTime();
const a = '[09:05:08.007] ';
const b = '[09:05:08.021] ';
const c = '[09:05:09.007] ';

test('timestamps follow line starts across fragmented reads and mixed line endings', () => {
  const log = createSerialPreview(100);
  log.append('\nA', first);
  const earlier = log.snapshot();
  log.append('中\r', first + 10);
  log.append('\n\rB\nC', first + 14);
  log.append('D\n\n', first + 1000);
  const view = log.snapshot();
  assert.equal(view.text, '\nA中\r\n\rB\nCD\n\n');
  assert.equal(timestampedPreview(view), a + '\n' + a + 'A中\r\n' + b + '\r' + b + 'B\n' + b + 'CD\n' + c + '\n');
  assert.equal(timestampedPreview(earlier), a + '\n' + a + 'A');
});

test('a retained partial line keeps its original timestamp after repeated truncation', () => {
  const log = createSerialPreview(6);
  assert.equal(timestampedPreview(log.snapshot()), '');
  log.append('hello\nA', first);
  log.append('longpartialline', first + 14);
  log.append('\nB', first + 1000);
  assert.equal(timestampedPreview(log.snapshot()), a + 'line\n' + c + 'B');
});

test('short-line bursts cap the preview and preserve split CRLF and the selected location', () => {
  const log = createSerialPreview(240000, 3);
  log.append('WARN A\r', first);
  log.append('\nWARN B\nWARN C\n', first + 14);
  const before = log.snapshot();
  log.append('WARN D\n', first + 1000);
  const after = log.snapshot();
  assert.equal(after.text, 'WARN B\nWARN C\nWARN D\n');
  for (const timed of [false, true]) {
    const anchor = view => previewOffset(view, timed) +
      (timed ? timestampedPreview(view) : view.text).indexOf('WARN B');
    assert.equal(anchor(before), anchor(after));
  }
  log.append('\n'.repeat(30000), first);
  assert.equal(log.snapshot().text, '\n\n\n');
});

test('a new connection starts a fresh preview line even after a partial final message', () => {
  const log = createSerialPreview(100);
  log.append('old device', first);
  log.beginSession();
  log.append('');
  assert.equal(log.snapshot().text, 'old device');
  log.append('new device', first + 1000);
  assert.equal(timestampedPreview(log.snapshot()), a + 'old device\n' + c + 'new device');
  log.beginSession();
  log.append('\r\nthird device', first + 1000);
  assert.equal(log.snapshot().text, 'old device\nnew device\r\nthird device');
});
