import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalBoardSlug, downloadFirmware, publishedBoards } from '../src/catalog.mjs';
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
        assert.equal(release.bin_url, `./firmware/${hardware.firmwareKey}-v${release.version}-${release.sha256}.binpkg`);
      } else {
        assert.match(release.bin_url, /^\.\/firmware\/[A-Za-z0-9][A-Za-z0-9._+-]{0,249}\.bin$/);
      }
      assert.notEqual(release.bin_url, `./firmware/${release.sha256}.bin`);
    }
  }
});

test('only listed ESP32 chips and BK7258 appear in a mixed catalog', () => {
  const board = JSON.parse(readFileSync(new URL('../boards.json', import.meta.url))).boards[0];
  const chips = ['OTHER', 'ESP32-X99', 'ESP32-C3', 'BK7258'];
  const boards = chips.map((chip, index) => ({ ...board, chip, slug: 'board-' + index }));
  assert.deepEqual(
    publishedBoards({ boards }, 'https://example.com/boards.json').map((entry) => entry.chip),
    ['ESP32-C3', 'BK7258'],
  );
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
