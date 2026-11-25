import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getLierdaHardwareProfile, matchLierdaBootFingerprint,
  matchesLierdaApplicationLayout, parseLierdaPackage,
} from '../src/lierda-package.mjs';

function packageHeader(product) {
  const bytes = new Uint8Array(52 + 2 * 140 + 364);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('111\0\0\0\0\0bpkg'));
  view.setUint32(16, 4, true);
  bytes.set(encoder.encode('SHA256'), 20);
  view.setUint16(28, 2, true);
  view.setUint16(30, 2 * 140, true);
  view.setUint32(52, 1, true);
  bytes.set(encoder.encode('pkgmode'), 56);
  view.setUint32(120, 1, true);
  view.setUint32(192, 2, true);
  bytes.set(encoder.encode('productname'), 196);
  bytes.set(encoder.encode(product), 260);
  return bytes;
}

test('Lierda packages require the selected product and an application stage', async () => {
  const lite = packageHeader('EC718PM_PRD');
  const f9 = packageHeader('EC718HM_PRD');
  await assert.rejects(parseLierdaPackage(lite, { model: 'pro-f9', stage: 'app' }), /EC718HM_PRD/);
  await assert.rejects(parseLierdaPackage(f9, { model: 'lite', stage: 'app' }), /EC718PM_PRD/);
  await assert.rejects(parseLierdaPackage(f9, { model: 'pro-f9', stage: 'assets' }), /应用固件包/);
  await assert.rejects(parseLierdaPackage(lite, { model: 'pro', stage: 'app' }), /受支持的利尔达板型/);
  await assert.rejects(parseLierdaPackage(f9, { model: 'pro-f9', stage: 'app' }), /BL 镜像地址/);
});

test('boot fingerprints choose a connected Lierda profile without using a selected model', () => {
  const lite = matchLierdaBootFingerprint('8984343af1cf62774c257cff67d7dd965753343b3c0bf7b457fe545b2593d963');
  assert.equal(lite.model, 'lite');
  assert.equal(lite.chip, 'EC718PM');
  const f9 = matchLierdaBootFingerprint('87ee2d2b52216763d21d24aea181ae4bc20bec8681e1c3464f3c1c00c77f21dd');
  assert.equal(f9.model, 'pro-f9');
  assert.equal(f9.chip, 'EC718HM');
  assert.equal(matchLierdaBootFingerprint('0'.repeat(64)), undefined);
});

test('the Lite app layout distinguishes the old NT26F6D0 Pro which shares its boot fingerprint', () => {
  const { app } = getLierdaHardwareProfile('lite');
  const liteHeader = Buffer.from('617070305161aa001860aa003861aa000010370000300700', 'hex');
  const oldProHeader = Buffer.from('617070304961aa001860aa003061aa0000c03b0000800200', 'hex');

  assert.equal(matchesLierdaApplicationLayout(liteHeader, app), true);
  assert.equal(matchesLierdaApplicationLayout(oldProHeader, app), false);
});

test('NT26F9D0 preserves both ends of internal Flash and checks the app filesystem layout', () => {
  const lite = getLierdaHardwareProfile('lite');
  const f9 = getLierdaHardwareProfile('pro-f9');
  assert.equal(lite.size, 0x400000);
  assert.equal(f9.size, 0x800000);
  assert.equal(f9.applicationOnly, true);
  assert.deepEqual(f9.eraseRanges, [{ start: 0x2ad000, end: 0x561000 }]);
  assert.deepEqual(f9.preservedRanges, [{ start: 0, end: 0x2ad000 }, { start: 0x561000, end: 0x800000 }]);

  const app = new Uint8Array(24);
  app.set(new TextEncoder().encode('app0'));
  const view = new DataView(app.buffer);
  view.setUint32(16, 0x561000, true);
  view.setUint32(20, 0x276000, true);
  assert.equal(matchesLierdaApplicationLayout(app, f9.app), true);
  assert.equal(matchesLierdaApplicationLayout(app, lite.app), false);
});
