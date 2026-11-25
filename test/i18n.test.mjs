import assert from 'node:assert/strict';
import test from 'node:test';
import { getLanguage, localizedMessage, releaseLabel, setLanguage, t } from '../src/i18n.mjs';
import { prepareFirmware } from '../src/firmware.mjs';
import { encodeSerialCommand } from '../src/serial-command.mjs';

test('switches interface and validation messages while preserving inserted data', () => {
  const original = getLanguage();
  try {
    setLanguage('en');
    assert.equal(t('串口日志'), 'Serial console');
    assert.equal(t('选定固件：@0\n', '设备-@1.bin'), 'Selected firmware: 设备-@1.bin\n');
    assert.equal(releaseLabel('v1（测试版）'), 'v1 (beta)');
    assert.throws(() => prepareFirmware({ origin: 'official' }), /Select a board/);
    setLanguage('zh-CN');
    assert.equal(t('串口日志'), '串口日志');
    assert.equal(t('选定固件：@0\n', '设备-@1.bin'), '选定固件：设备-@1.bin\n');
    assert.throws(() => prepareFirmware({ origin: 'official' }), /请选择开发板/);
  } finally {
    setLanguage(original);
  }
});

test('existing status messages and nested errors follow language changes', () => {
  const original = getLanguage();
  try {
    setLanguage('en');
    let error;
    try {
      encodeSerialCommand('Z', 'hex', '');
    } catch (cause) {
      error = cause;
    }
    assert.ok(error instanceof Error);
    const status = localizedMessage('发送失败。@0', error);
    const deviceReply = localizedMessage('设备返回 @0', '时间戳 @0');
    assert.match(t(status), /^Send failed\. Enter complete two-digit hex bytes/);
    assert.equal(t(deviceReply), 'Device replied: 时间戳 @0');
    const version = 'v1.2.0 · xiaotai（特别版）';
    assert.equal(releaseLabel(version), 'v1.2.0 · xiaotai (special edition)');
    setLanguage('zh-CN');
    assert.match(t(status), /^发送失败。HEX 请输入完整的两位字节/);
    assert.equal(t(deviceReply), '设备返回 时间戳 @0');
    assert.equal(releaseLabel(version), version);
    setLanguage('en');
    assert.match(t(status), /^Send failed\. Enter complete two-digit hex bytes/);
  } finally {
    setLanguage(original);
  }
});
