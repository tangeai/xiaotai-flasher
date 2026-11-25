import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBoards, publishedBoards } from '../src/catalog.mjs';
import { lierdaBoards, prepareLierdaFirmware, resolveLierdaFirmware } from '../src/lierda-firmware.mjs';

const base = 'https://host.test/web-flasher/';
const catalogURL = base + 'board-catalog/boards.json';

function entry(hardware, releases) {
  return {
    slug: hardware.slug, model: hardware.name, chip: hardware.chip,
    modem: hardware.modem, modempkg: hardware.modempkg, flash_bytes: hardware.flashBytes,
    releases,
  };
}

function packageRelease(product, sha256 = 'a'.repeat(64), version = '1.0.0') {
  return {
    version, status: 'published', bin_url: `./firmware/${product}-v${version}-${sha256}.binpkg`,
    source_filename: `2026_11_21_16_05_10_${product}.binpkg`, byte_length: 3, sha256,
  };
}

test('an empty or pre-Lierda catalog does not enable a built-in online firmware', () => {
  assert.deepEqual(publishedBoards({ boards: [] }, catalogURL), []);
  for (const hardware of lierdaBoards) {
    const [board] = publishedBoards({ boards: [entry(hardware, [])] }, catalogURL);
    assert.deepEqual(board.versions, []);
    assert.throws(() => prepareLierdaFirmware({ model: hardware.model, origin: 'official' }), /暂无可选/);
  }
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

for (const hardware of lierdaBoards) {
  test(`${hardware.name} loads its selected original filename and verifies the shared catalog binary`, async (t) => {
    const bytes = Uint8Array.of(0x42, 0x49, 0x4e);
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const product = hardware.slug.slice('lierda-'.length);
    const older = packageRelease(product, hash);
    const latest = { ...packageRelease(product, '1'.repeat(64), '1.0.1'), recommended: true };
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return Response.json({ boards_url: './board-catalog/boards.json' });
      if (calls.length === 2) return Response.json({ boards: [entry(hardware, [latest, older])] });
      return new Response(bytes);
    });

    const [board] = await loadBoards(new URL('boards-source.json', base));
    assert.equal(board.slug, hardware.slug);
    assert.equal(board.model, hardware.name);
    assert.equal(board.versions[0].recommended, true);
    const selectedRelease = board.versions.find((release) => release.version === older.version);
    const selected = prepareLierdaFirmware({ model: hardware.model, origin: 'official', selectedRelease }, hardware.flashBytes);
    assert.equal(selected.boardModel, hardware.name);
    assert.equal(selected.filename, older.source_filename);
    assert.deepEqual(await resolveLierdaFirmware(selected), {
      bytes, model: hardware.model, stage: 'app', filename: older.source_filename, sha256: hash,
    });
    assert.deepEqual(calls, [base + 'boards-source.json', catalogURL, new URL(older.bin_url, catalogURL).href]);
  });
}

test('malformed or conflicting BINPKG records leave other platforms available', () => {
  const [lite, pro] = lierdaBoards;
  const valid = packageRelease('pro');
  const stock = { slug: 'stock', model: 'Stock', chip: 'ESP32', releases: [{
    version: '1', status: 'published', sha256: 'f'.repeat(64), bin_url: './legacy.bin',
  }] };
  const keep = [stock, entry(lite, [packageRelease('lite')])];
  const expected = keep.map((board) => board.slug);
  const listed = (records) => publishedBoards({ boards: [...keep, ...records] }, catalogURL).map((board) => board.slug);
  for (const mismatch of [
    { modem: 'NT26F6D0' }, { modempkg: 'F6D_D' }, { chip: 'ESP32' }, { flash_bytes: 0x400000 },
    { releases: [valid, valid] }, { releases: null },
  ]) {
    assert.deepEqual(listed([{ ...entry(pro, [valid]), ...mismatch }]), expected);
  }
  for (const mismatch of [
    { bin_url: '../bad.binpkg' }, { bin_url: packageRelease('lite').bin_url }, { source_filename: '../bad.binpkg' },
    { version: 'Pro 测试版' }, { byte_length: 0x810001 }, { sha256: 'bad' }, { recommended: 'yes' },
  ]) {
    assert.deepEqual(listed([entry(pro, [{ ...valid, ...mismatch }])]), expected);
  }
  assert.deepEqual(listed([entry(pro, [valid]), entry(pro, [])]), expected);
});

test('only published BINPKGs appear and Pro excludes prereleases', () => {
  const [lite, pro] = lierdaBoards;
  const records = (product) => [
    { ...packageRelease(product, 'b'.repeat(64), '2.0.0'), prerelease: true },
    { ...packageRelease(product, 'c'.repeat(64), '3.0.0'), status: 'draft' },
    { ...packageRelease(product), recommended: true },
  ];
  const [voice, video] = publishedBoards({ boards: [entry(lite, records('lite')), entry(pro, records('pro'))] }, catalogURL);
  assert.deepEqual(voice.versions.map((release) => release.version), ['2.0.0', '1.0.0']);
  assert.equal(voice.versions[0].prerelease, true);
  assert.equal(voice.versions[1].recommended, true);
  assert.deepEqual(video.versions.map((release) => release.version), ['1.0.0']);
});
