import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSerialCommand } from '../src/serial-command.mjs';

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
