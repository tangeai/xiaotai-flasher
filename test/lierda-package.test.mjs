import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { makePmFixture, populatePmSdkEntry } from './fixtures/lierda-hm.mjs';
import {
  getLierdaFlashPlan, getLierdaHardwareProfile, lierdaBootCandidates, matchLierdaBootFingerprint,
  matchLierdaDeviceLayout, matchesLierdaApplicationLayout, parseLierdaPackage,
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

test('distinguishes a corrupt BINPKG header from unsupported extra images', async () => {
  const damaged = packageHeader('EC718PM_PRD');
  damaged[0] = 0;
  const extended = packageHeader('EC718PM_PRD');
  new DataView(extended.buffer).setUint32(16, 5, true);
  const options = { model: 'lite', stage: 'app' };
  await assert.rejects(parseLierdaPackage(damaged, options), /文件头无效/);
  await assert.rejects(parseLierdaPackage(extended, options), /额外镜像或配置/);
});

test('boot fingerprints choose a connected Lierda profile without using a selected model', () => {
  const lite = matchLierdaBootFingerprint('8984343af1cf62774c257cff67d7dd965753343b3c0bf7b457fe545b2593d963');
  assert.equal(lite.model, 'lite');
  assert.equal(lite.chip, 'EC718PM');
  const hmBoot = '87ee2d2b52216763d21d24aea181ae4bc20bec8681e1c3464f3c1c00c77f21dd';
  assert.deepEqual(lierdaBootCandidates(hmBoot).map(p => p.sdkVersion).sort(), ['1.7.0', '1.7.1']);
  assert.equal(matchLierdaBootFingerprint(hmBoot), undefined);
  assert.equal(matchLierdaBootFingerprint(hmBoot, '0'.repeat(64)), undefined);
  for (const [ap, version] of [
    ['421b0d5cb8f195e98262f1efc537e64b5428e7a01c572fda8e0d9106e6cf3729', '1.7.0'],
    ['26d07457145adb4e006dbe2eda0b0f5b12136d20d2df3a108a4389ae3747d015', '1.7.1'],
  ]) {
    const f9 = matchLierdaBootFingerprint(hmBoot, ap);
    assert.equal(f9.model, 'pro-f9');
    assert.equal(f9.chip, 'EC718HM');
    assert.equal(f9.sdkVersion, version);
  }
  assert.equal(matchLierdaBootFingerprint('0'.repeat(64)), undefined);
});

test('PM Pro bundles require an external image and the correct product', async () => {
  const appOnly = packageHeader('EC718PM_PRD');
  await assert.rejects(parseLierdaPackage(appOnly, { model: 'pro-pm', stage: 'app' }), /ext_lfs/);
  const wrongChip = packageHeader('EC718HM_PRD');
  new DataView(wrongChip.buffer).setUint32(16, 5, true);
  await assert.rejects(parseLierdaPackage(wrongChip, { model: 'pro-pm', stage: 'app' }), /EC718PM_PRD/);
  await assert.rejects(parseLierdaPackage(wrongChip, { model: 'pro-f9', stage: 'app' }), /四个内部 Flash/);
});

test('PM Lite and Pro require separate application identity evidence on the shared PM layout', () => {
  const lite = getLierdaHardwareProfile('lite');
  const pro = getLierdaHardwareProfile('pro-pm');
  const compact = Buffer.from('617070305161aa001860aa003861aa000010370000300700', 'hex');
  const shared = Buffer.from('617070304961aa001860aa003061aa0000c03b0000800200', 'hex');
  assert.equal(matchLierdaDeviceLayout(lite, compact), lite);
  assert.equal(matchLierdaDeviceLayout(lite, compact, 'lite'), lite);
  assert.equal(matchLierdaDeviceLayout(lite, compact, 'pro-pm'), undefined);
  assert.equal(matchLierdaDeviceLayout(lite, shared), undefined);
  assert.equal(matchLierdaDeviceLayout(lite, shared, 'pro-pm'), pro);
  const largeLite = matchLierdaDeviceLayout(lite, shared, 'lite');
  assert.equal(largeLite.model, 'lite');
  assert.equal(largeLite.externalSize, undefined);
  assert.equal(largeLite.app.fsStart, pro.app.fsStart);
  for (const [source, target] of [[lite, largeLite], [largeLite, lite], [largeLite, largeLite]]) {
    assert.deepEqual(getLierdaFlashPlan(source, target), getLierdaFlashPlan(lite, lite));
  }
  for (const [source, target] of [[largeLite, pro], [pro, largeLite]]) {
    assert.throws(() => getLierdaFlashPlan(source, target));
  }
});

test('four-image Lite packages require matching application name, capacity and filesystem layout', async t => {
  const pins = new Map();
  const { firmware } = makePmFixture(getLierdaHardwareProfile('pro-pm'), pins);
  // Pin only the existing synthetic base images to their vendor identities.
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, data) => {
    const pinned = pins.get(hash(data));
    return pinned ? Uint8Array.from(Buffer.from(pinned, 'hex')).buffer : digest(algorithm, data);
  });
  const bytes = firmware.bytes;
  let appOffset = 52 + bytes.readUInt16LE(30);
  for (let i = 0; i < 3; i++) appOffset += 364 + bytes.readUInt32LE(appOffset + 76);
  const end = appOffset + 364 + bytes.readUInt32LE(appOffset + 76);
  function litePackage(name, capacity, fsStart, fsSize, programModel = 'lite') {
    const lite = Buffer.from(bytes.subarray(0, end));
    lite.writeUInt32LE(4, 16);
    lite.fill(0, appOffset, appOffset + 64);
    lite.write(name, appOffset);
    lite.writeUInt32LE(capacity, appOffset + 68);
    const app = lite.subarray(appOffset + 364);
    populatePmSdkEntry(app, 0, programModel);
    app.writeUInt32LE(fsStart, 16);
    app.writeUInt32LE(fsSize, 20);
    lite.write(hash(app), appOffset + 80);
    return lite;
  }

  const options = { model: 'lite', stage: 'app' };
  for (const [capacity, start, size] of [[0xcb000, 0x371000, 0x73000], [0x116000, 0x3bc000, 0x28000]]) {
    const lite = litePackage('TiRTC_Lite_AI_NT26F6D0_device_02', capacity, start, size);
    const plan = await parseLierdaPackage(lite, options);
    assert.equal(plan.profile.model, 'lite');
    assert.equal(plan.profile.app.capacity, capacity);
    assert.equal(plan.profile.externalSize, undefined);
    assert.deepEqual(plan.images.map(image => image.role), ['BL', 'AP', 'CP', 'APP']);
    await assert.rejects(parseLierdaPackage(lite, { ...options, model: 'pro-pm' }), /ext_lfs/);
  }
  const wrongProgram = litePackage('TiRTC_Lite_AI_NT26F6D0_device_02', 0x116000, 0x3bc000, 0x28000, 'pro-pm');
  await assert.rejects(parseLierdaPackage(wrongProgram, options), /应用镜像标识/);
  const sharedLite = litePackage('TiRTC_Lite_AI_NT26F6D0_device_02', 0x116000, 0x3bc000, 0x28000);
  for (const [model, bundle] of [['lite', sharedLite], ['pro-pm', Buffer.from(bytes)]]) {
    const app = bundle.subarray(appOffset + 364, end);
    app.write('V1.7.0_unidentified\0', 0x3000);
    bundle.write(hash(app), appOffset + 80);
    await assert.rejects(parseLierdaPackage(bundle, { ...options, model }), /应用镜像标识/);
  }
  const truncated = Buffer.from(bytes.subarray(0, appOffset + 10));
  truncated.writeUInt32LE(4, 16);
  await assert.rejects(parseLierdaPackage(truncated, options), /APP 镜像头越界/);
  await assert.rejects(parseLierdaPackage(bytes, options));
  await assert.rejects(parseLierdaPackage(litePackage('TiRTC_pro_NT26F6D0', 0x116000, 0x3bc000, 0x28000), options),
    /应用镜像类型/);
  await assert.rejects(parseLierdaPackage(litePackage('TiRTC_Lite_AI_NT26F6D0_device_02', 0xcb000, 0x3bc000, 0x28000), options),
    /文件系统布局/);
});

test('PM Pro updates only the internal app range and keeps SPI1 out of its internal erase plan', () => {
  const pro = getLierdaHardwareProfile('pro-pm');
  const lite = getLierdaHardwareProfile('lite');
  const hm = getLierdaHardwareProfile('pro-f9');
  assert.equal(pro.size, 0x400000);
  assert.equal(pro.externalSize, 0x400000);
  const plan = getLierdaFlashPlan(pro, pro);
  assert.equal(plan.mode, 'pm-pro');
  assert.deepEqual(plan.eraseRanges, [{ start: 0x2a6000, end: 0x3bc000 }]);
  assert.deepEqual(plan.preservedRanges, [{ start: 0, end: 0x2a6000 }, { start: 0x3bc000, end: 0x400000 }]);
  for (const other of [lite, hm]) {
    assert.throws(() => getLierdaFlashPlan(other, pro), /不匹配/);
    assert.throws(() => getLierdaFlashPlan(pro, other), /不匹配/);
  }
});

test('NT26F9D0 preserves both ends of internal Flash and checks the app filesystem layout', () => {
  const lite = getLierdaHardwareProfile('lite');
  const f9 = getLierdaHardwareProfile('pro-f9', '1.7.0');
  const f9New = getLierdaHardwareProfile('pro-f9', '1.7.1');
  assert.equal(lite.size, 0x400000);
  assert.equal(f9.size, 0x800000);
  assert.equal(f9.applicationOnly, true);
  assert.deepEqual(f9.eraseRanges, [{ start: 0x2c1000, end: 0x575000 }]);
  assert.deepEqual(f9.preservedRanges, [{ start: 0, end: 0x2c1000 }, { start: 0x575000, end: 0x800000 }]);
  assert.deepEqual(f9New.eraseRanges, [{ start: 0x2ad000, end: 0x561000 }]);
  assert.deepEqual(f9New.preservedRanges, [{ start: 0, end: 0x2ad000 }, { start: 0x561000, end: 0x800000 }]);

  const app = new Uint8Array(24);
  app.set(new TextEncoder().encode('app0'));
  const view = new DataView(app.buffer);
  view.setUint32(16, 0x575000, true);
  view.setUint32(20, 0x262000, true);
  assert.equal(matchesLierdaApplicationLayout(app, f9.app), true);
  assert.equal(matchesLierdaApplicationLayout(app, f9New.app), false);
  assert.equal(matchesLierdaApplicationLayout(app, lite.app), false);
  view.setUint32(16, 0x561000, true);
  view.setUint32(20, 0x276000, true);
  assert.equal(matchesLierdaApplicationLayout(app, f9.app), false);
  assert.equal(matchesLierdaApplicationLayout(app, f9New.app), true);
});

test('HM clean install erases both APP filesystems but protects fuse, factory and platform data', () => {
  const hm170 = getLierdaHardwareProfile('pro-f9', '1.7.0');
  const hm171 = getLierdaHardwareProfile('pro-f9', '1.7.1');
  for (const [source, target] of [[hm170, hm171], [hm171, hm170]]) {
    assert.equal(getLierdaFlashPlan(source, source).mode, 'app');
    const plan = getLierdaFlashPlan(source, target);
    assert.equal(plan.mode, 'reinstall');
    assert.deepEqual(plan.eraseRanges, [
      { start: 0, end: 0x2000 }, { start: 0x3000, end: 0x23000 }, { start: 0x2d000, end: 0x7e4000 },
    ]);
    assert.deepEqual(plan.preservedRanges, [
      { start: 0x2000, end: 0x3000 }, { start: 0x23000, end: 0x2d000 }, { start: 0x7e4000, end: 0x800000 },
    ]);
    for (const { app } of [source, target]) {
      assert.ok(plan.eraseRanges.some(({ start, end }) => start <= app.fsStart && app.fsStart + app.fsSize <= end));
    }
    assert.throws(() => getLierdaFlashPlan(getLierdaHardwareProfile('lite'), target));
  }
});
