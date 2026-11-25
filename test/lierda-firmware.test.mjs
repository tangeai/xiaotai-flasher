import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lierdaBoards, loadLierdaLiteReleases, loadLierdaProRelease, prepareLierdaFirmware, resolveLierdaFirmware,
} from '../src/lierda-firmware.mjs';

test('selects the pinned Lite download and keeps Pro local when its online catalog is absent', () => {
  const [lite, pro] = lierdaBoards;
  const selected = prepareLierdaFirmware({ model: lite.model, origin: 'official' });
  assert.equal(selected.filename, '2026_11_21_16_05_10_lite.binpkg');
  assert.equal(selected.release.version, '1.0.0 · xiaotai-lierda Lite');
  assert.equal(selected.release.byte_length, 3449160);
  assert.equal(selected.chip, 'EC718PM');
  assert.equal(pro.slug, 'lierda-pro');
  assert.equal(pro.release, undefined);
  assert.throws(() => prepareLierdaFirmware({ model: pro.model, origin: 'official' }), /本地 F9D_D/);
});

test('routes a complete local Pro package for APP-only parsing', async () => {
  const file = new File([Uint8Array.of(1, 2, 3)], 'my-firmware.BINPKG');
  const firmware = prepareLierdaFirmware({ model: 'pro-f9', file, origin: 'local' }, 0x800000);
  assert.equal(firmware.chip, 'EC718HM');
  assert.deepEqual(await resolveLierdaFirmware(firmware), {
    bytes: Uint8Array.of(1, 2, 3),
    model: 'pro-f9',
    stage: 'app',
    filename: file.name,
  });
});

test('rejects the wrong capacity, file extension and oversized package', () => {
  const file = new File([Uint8Array.of(1)], 'firmware.bin');
  const selection = { model: 'lite', origin: 'local', file };
  assert.throws(() => prepareLierdaFirmware(selection, 0x800000), /Flash 容量.*不匹配/);
  assert.throws(() => prepareLierdaFirmware(selection), /扩展名/);
  const oversized = new File([new Uint8Array(0x410001)], 'firmware.binpkg');
  assert.throws(() => prepareLierdaFirmware({ ...selection, file: oversized }), /大小限制/);
});

test('rejects local files that change size during a read and aborted selections', async () => {
  const file = {
    name: 'firmware.binpkg',
    size: 2,
    async arrayBuffer() { return new ArrayBuffer(1); },
  };
  const firmware = prepareLierdaFirmware({ model: 'lite', origin: 'local', file });
  await assert.rejects(resolveLierdaFirmware(firmware), /文件大小发生变化/);
  const signal = AbortSignal.abort(new Error('selection cancelled'));
  await assert.rejects(resolveLierdaFirmware(firmware, signal), /selection cancelled/);
});

test('loads the same-origin Pro release and downloads its exact bytes for APP staging', async (t) => {
  const bytes = Uint8Array.of(0x42, 0x49, 0x4e);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const base = 'https://host.test/web-flasher/';
  const manifest = {
    modem: 'NT26F9D0', modempkg: 'F9D_D',
    version: 'repair3 测试版', filename: 'sample.binpkg', byte_length: bytes.length, sha256: hash,
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? Response.json(manifest) : new Response(bytes);
  });
  const release = await loadLierdaProRelease(undefined, base);
  const selection = prepareLierdaFirmware({ model: 'pro-f9', origin: 'official', proRelease: release }, 0x800000);
  assert.deepEqual(await resolveLierdaFirmware(selection), {
    bytes, model: 'pro-f9', stage: 'app', filename: 'sample.binpkg', sha256: hash,
  });
  assert.deepEqual(urls, [
    base + 'lierda/firmware/pro.json',
    base + 'lierda/firmware/sample.binpkg',
  ]);
});

test('missing and mismatched Pro catalog entries cannot enable online flashing', async (t) => {
  const base = 'https://host.test/web-flasher/';
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await loadLierdaProRelease(undefined, base), null);
  const valid = {
    modem: 'NT26F9D0', modempkg: 'F9D_D', version: '测试版', filename: 'f9.binpkg', byte_length: 1,
    sha256: '1'.repeat(64),
  };
  for (const mismatch of [
    { modem: 'NT26F6D0' }, { modempkg: 'F6D_D' }, { filename: '../f9.binpkg' },
    { byte_length: 0x810001 }, { sha256: 'bad hash' },
  ]) {
    mocked.mock.mockImplementation(async () => Response.json({ ...valid, ...mismatch }));
    await assert.rejects(loadLierdaProRelease(undefined, base), /固件目录配置无效/);
  }
});

test('loads selectable same-origin Lite releases and resolves the chosen older version', async (t) => {
  const base = 'https://host.test/web-flasher/';
  const bytes = Uint8Array.of(0x42, 0x49, 0x4e);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const older = {
    modem: 'NT26F6D0', modempkg: 'F6D_D',
    version: '0.2.0', filename: 'lite-older.binpkg', byte_length: bytes.length, sha256: hash,
  };
  const current = {
    ...older, version: '0.3.0', filename: 'lite-current.binpkg', recommended: true,
    sha256: '1'.repeat(64),
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? Response.json({ releases: [current, older] }) : new Response(bytes);
  });

  const releases = await loadLierdaLiteReleases(undefined, base);
  assert.deepEqual(releases.map(({ version, recommended }) => [version, recommended]), [
    ['0.3.0', true],
    ['0.2.0', false],
  ]);
  const firmware = prepareLierdaFirmware(
    { model: 'lite', origin: 'official', selectedRelease: releases[1] },
    0x400000,
  );
  assert.equal(firmware.release.version, '0.2.0');
  assert.deepEqual(await resolveLierdaFirmware(firmware), {
    bytes, model: 'lite', stage: 'app', filename: 'lite-older.binpkg', sha256: hash,
  });
  assert.deepEqual(urls, [base + 'lierda/firmware/lite.json', base + 'lierda/firmware/lite-older.binpkg']);
});

test('validates Lite manifest identity, file bounds, and unique version labels', async (t) => {
  const base = 'https://host.test/web-flasher/';
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await loadLierdaLiteReleases(undefined, base), null);
  const valid = {
    modem: 'NT26F6D0', modempkg: 'F6D_D', version: '0.2.0',
    filename: 'lite.binpkg', byte_length: 1, sha256: '1'.repeat(64),
  };
  for (const mismatch of [
    { modem: 'NT26F9D0' }, { modempkg: 'F9D_D' }, { filename: '../sample.binpkg' },
    { byte_length: 0x410001 }, { sha256: 'bad hash' },
  ]) {
    mocked.mock.mockImplementation(async () => Response.json({ releases: [{ ...valid, ...mismatch }] }));
    await assert.rejects(loadLierdaLiteReleases(undefined, base), /固件目录配置无效/);
  }

  mocked.mock.mockImplementation(async () => Response.json({ releases: [valid, { ...valid, filename: 'other.binpkg' }] }));
  await assert.rejects(loadLierdaLiteReleases(undefined, base), /重复版本/);

  const pinned = prepareLierdaFirmware({ model: 'lite', origin: 'official' });
  assert.equal(pinned.filename, '2026_11_21_16_05_10_lite.binpkg');
});
