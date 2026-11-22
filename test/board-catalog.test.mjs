import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { downloadFirmware, publishedBoards } from '../src/catalog.mjs';

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
      assert.equal(release.bin_url, `./firmware/${release.sha256}.bin`);
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
