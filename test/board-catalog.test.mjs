import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalBoardSlug, downloadFirmware, publishedBoards, publishedCatalog } from '../src/catalog.mjs';
import { catalogPlatforms, flashProtocol } from '../src/catalog-platforms.mjs';
import { lierdaBoards } from '../src/lierda-boards.mjs';

test('the manual firmware catalog loads and uses the Nginx BIN paths', () => {
  const file = new URL('../boards.json', import.meta.url);
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  const url = new URL(
    'https://xiaotai.chat/web-flasher/board-catalog/boards.json',
  );
  assert.ok(publishedBoards(catalog, url).length);

  for (const board of catalog.boards) {
    for (const release of board.releases) {
      if (release.status !== 'published') continue;
      assert.match(release.sha256, /^[a-f0-9]{64}$/);
      const hardware = lierdaBoards.find(({ slug }) => slug === board.slug);
      if (hardware) {
        assert.ok([
          `./firmware/${hardware.firmwareKey}-v${release.version}-${release.sha256}.binpkg`,
          `./firmware/v${release.version}-${hardware.slug}.binpkg`,
        ].includes(release.bin_url));
      } else {
        assert.match(release.bin_url, /^\.\/firmware\/[A-Za-z0-9][A-Za-z0-9._+-]{0,249}\.bin$/);
      }
      assert.notEqual(release.bin_url, `./firmware/${release.sha256}.bin`);
    }
  }
});

test('legacy catalogs only list supported chips', () => {
  const board = JSON.parse(readFileSync(new URL('../boards.json', import.meta.url))).boards[0];
  delete board.platform;
  delete board.platform_name;
  const chips = ['OTHER', 'ESP32-X99', 'ESP32-C3', 'BK7258'];
  const boards = chips.map((chip, index) => ({ ...board, chip, slug: 'board-' + index }));
  assert.deepEqual(
    publishedBoards({ boards }, 'https://example.com/boards.json').map((entry) => entry.chip),
    ['ESP32-C3', 'BK7258'],
  );
});

test('catalog platform IDs group boards independently of chip and protocol', () => {
  const row = { chip: 'EC718PM', model: 'Voice board', releases: [], platform: 'voice', platform_name: '语音' };
  const boards = publishedBoards({ boards: [
    { ...row, slug: 'voice-a' },
    { ...row, slug: 'other', platform: 'lab', platform_name: '验证板' },
    { ...row, slug: 'voice-b', chip: 'ESP32-S3' },
  ] }, 'https://example.com/boards.json');
  assert.deepEqual([...catalogPlatforms(boards)], [['voice', '语音'], ['lab', '验证板']]);
  assert.deepEqual(boards.filter(board => board.platform === 'voice').map(board => board.slug), ['voice-a', 'voice-b']);
  assert.deepEqual(boards.map(flashProtocol), [null, null, 'esp32']);
  assert.deepEqual(boards[0].versions, []);
  assert.throws(() => publishedBoards({ boards: [
    { ...row, slug: 'first' }, { ...row, slug: 'second', platform_name: 'Other' },
  ] }, 'https://example.com/boards.json'), /平台/);
});

test('top-level platform definitions set the menu order and resolve board references', () => {
  const platforms = [
    { platform: 'lab', platform_name: '实验室' }, { platform: 'voice', platform_name: '语音' },
  ];
  const row = { slug: 'voice-a', model: 'Voice board', chip: 'EC718PM', releases: [], platform: 'voice' };
  const url = 'https://example.com/boards.json';
  const catalog = publishedCatalog({ platforms, boards: [row, { ...row, slug: 'voice-b' }] }, url);
  assert.deepEqual([...catalog.platforms], [['lab', '实验室'], ['voice', '语音']]);
  assert.deepEqual(catalog.boards.map(board => board.platform), ['voice', 'voice']);
  assert.throws(() => publishedCatalog({ platforms, boards: [{ ...row, platform: 'missing' }] }, url), /平台/);
  assert.throws(() => publishedCatalog({ platforms: [...platforms, platforms[0]], boards: [] }, url), /平台/);
});

test('cancels an in-progress firmware download when the device disconnects', async (t) => {
  const abort = new AbortController();
  const { promise: reading, resolve: markReading } = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), {
          once: true,
        });
      },
      pull() {
        markReading();
      },
    });
    return new Response(body);
  });
  const release = { bin_url: 'https://example.com/firmware.bin' };
  const pending = downloadFirmware(release, 4096, abort.signal);
  const error = new Error('Device disconnected');
  const rejected = assert.rejects(pending, (failure) => failure === error);
  await reading;
  abort.abort(error);
  await rejected;
});

test('displays the current prerelease label for older external catalogs', () => {
  const release = { version: 'v1.5.0 · xiaotai-esp32（体验版）', status: 'published',
    bin_url: './firmware/example.bin', sha256: 'a'.repeat(64) };
  const board = { slug: 'sample', model: 'sample', chip: 'ESP32', releases: [release] };
  const [loaded] = publishedBoards({ boards: [board] }, 'https://example.com/boards.json');
  assert.equal(loaded.versions[0].version, 'v1.5.0 · xiaotai-esp32（测试版）');
});

test('the CoreS3-Lite display variant resolves to the same catalog board', () => {
  const catalog = JSON.parse(readFileSync(new URL('../boards.json', import.meta.url)));
  const slug = canonicalBoardSlug('m5stack-cores3-lite-ili9342c');
  const boards = catalog.boards.filter((board) => canonicalBoardSlug(board.slug) === slug);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].slug, 'm5stack-cores3-lite');
  assert.ok(boards[0].releases.some((release) => release.bin_url.includes('_ili9342c_')));
});

test('loads dated firmware snapshots with screen-size slugs and canonical BINPKG paths', () => {
  const url = 'https://example.com/boards-2026-11-27.json';
  const hardware = lierdaBoards[0];
  const bin_url = './firmware/v1.0.0_' + hardware.slug + '.binpkg';
  const release = { status: 'published', version: '1.0.0', sha256: 'a'.repeat(64), byte_length: 32,
    source_filename: '2026_11_21_16_05_10_lite.binpkg', bin_url };
  const boards = [
    ...['waveshare-p4-3.5', 'waveshare-p4-4.3'].map(slug =>
      ({ platform: 'esp32', slug, model: slug, chip: 'ESP32-P4', releases: [] })),
    { platform: 'lierda', model: hardware.name, chip: hardware.chip, slug: hardware.slug,
      flash_bytes: hardware.flashBytes, modem: hardware.modem, modempkg: hardware.modempkg, releases: [release] },
  ];
  const platforms = ['esp32', 'lierda'].map(platform => ({ platform, platform_name: platform }));
  const published = publishedBoards({ platforms, boards }, url);
  assert.deepEqual(published.map(board => board.slug), boards.map(board => board.slug));
  assert.equal(published[2].versions[0].bin_url, new URL(bin_url, url).href);
});
