import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importLierdaLiteCatalog } from '../scripts/import-lierda-lite.mjs';

const api = 'https://api.github.com/repos/tangeai/xiaotai-lierda/releases?per_page=100&page=';
const downloads = 'https://github.com/tangeai/xiaotai-lierda/releases/download/';
const filename = 'release_lite.binpkg';
const tag = 'lite-v1.0.0';
const digest = (data) => createHash('sha256').update(data).digest('hex');

function asset(name, bytes, version = tag) {
  return {
    name, size: bytes.length, browser_download_url: downloads + version + '/' + name,
    digest: 'sha256:' + digest(bytes),
  };
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'lierda-lite-import-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, 'lite.json'), 'previous manifest');
  return path;
}

test('legacy, draft and prerelease tags leave the current Lite catalog in place', async (t) => {
  const path = await directory(t);
  const result = await importLierdaLiteCatalog(path, async (url) => {
    assert.equal(url, api + '1');
    return Response.json([
      { tag_name: '0.2.0' }, { tag_name: tag, draft: true },
      { tag_name: 'lite-v1.1.0', prerelease: true }, { tag_name: 'pro-v1.0.0' },
    ]);
  });
  assert.equal(result, null);
  assert.equal(await readFile(join(path, 'lite.json'), 'utf8'), 'previous manifest');
});

test('Lite import follows pagination and rejects a bad package before replacing the manifest', async (t) => {
  const path = await directory(t);
  const binary = Buffer.from('not a vendor package');
  const checksum = Buffer.from(`\uFEFF${digest(binary)} *${filename}\r\n`);
  const pkg = asset(filename, binary);
  const sums = asset('SHA256SUMS.txt', checksum);
  const calls = [];
  const routes = new Map([
    [api + '1', () => Response.json([{ tag_name: '0.2.0' }], {
      headers: { Link: '<' + api + '2>; rel="next"' },
    })],
    [api + '2', () => Response.json([{ tag_name: tag, assets: [pkg, sums] }])],
    [sums.browser_download_url, () => new Response(checksum)],
    [pkg.browser_download_url, () => new Response(binary)],
  ]);
  await assert.rejects(importLierdaLiteCatalog(path, async (url) => {
    calls.push(url);
    assert.ok(routes.has(url), url);
    return routes.get(url)();
  }), /匹配的利尔达内部 Flash binpkg/);
  assert.deepEqual(calls, [...routes.keys()]);
  assert.deepEqual(await readdir(path), ['lite.json']);
  assert.equal(await readFile(join(path, 'lite.json'), 'utf8'), 'previous manifest');
});

test('a checksum that disagrees with the GitHub asset digest stops before downloading the package', async (t) => {
  const path = await directory(t);
  const binary = Buffer.from('verified artifact placeholder');
  const checksum = Buffer.from(`${'f'.repeat(64)}  ${filename}\n`);
  const pkg = asset(filename, binary);
  const sums = asset('SHA256SUMS.txt', checksum);
  await assert.rejects(importLierdaLiteCatalog(path, async (url) => {
    if (url === api + '1') return Response.json([{ tag_name: tag, assets: [pkg, sums] }]);
    assert.equal(url, sums.browser_download_url);
    return new Response(checksum);
  }), /SHA-256 校验记录不一致/);
  assert.deepEqual(await readdir(path), ['lite.json']);
});
