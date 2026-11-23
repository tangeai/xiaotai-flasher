import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtReplyReader, encodeSerialCommand } from '../src/serial-command.mjs';

test('serial text keeps spaces and UTF-8 with the selected line ending', () => {
  for (const ending of ['', '\r', '\n', '\r\n'])
    assert.deepEqual(encodeSerialCommand(' 状态 ', 'text', ending), new TextEncoder().encode(' 状态 ' + ending));
});

test('hex sends the exact bytes independent of the text line ending', () => {
  for (const command of ['00 0a FF', '000Aff', ' 000a\tff '])
    assert.deepEqual([...encodeSerialCommand(command, 'hex', '\r\n')], [0, 10, 255]);
  for (const command of [' ', 'A B', '001', '0xFF', 'FF ZZ'])
    assert.throws(() => encodeSerialCommand(command, 'hex', ''), /HEX/);
});

test('AT accepts complete terminal lines across reads and ignores log text', () => {
  const read = createAtReplyReader(true);
  for (const chunk of ['AT\r\nINFO OK\n', 'OK extra\rOK', 'AY\n', 'x'.repeat(1000), 'OK\nO', 'K'])
    assert.equal(read(chunk), null);
  assert.equal(read('\r\n'), 'OK');
});

test('AT ignores pre-existing partial lines and returns a device error', () => {
  const read = createAtReplyReader(false);
  assert.equal(read('OK\r\nERROR: CLI_'), null);
  assert.equal(read('DISABLED\nOK\n'), 'ERROR: CLI_DISABLED');
});

test('AT distinguishes a starter console rejection from unrelated log text', () => {
  const read = createAtReplyReader(false);
  assert.equal(read('AT\r\nINFO Unrecognized command\r\n'), null);
  assert.equal(read('Unrecognized command in log\nUnrecog'), null);
  assert.equal(read('nized command\r\nstarter> '), 'Unrecognized command');
});
