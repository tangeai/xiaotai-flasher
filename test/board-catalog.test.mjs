import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { publishedBoards } from '../src/catalog.mjs';

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
