import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importLierdaLiteCatalog } from '../scripts/import-lierda-lite.mjs';
import { collectLierdaBoards } from '../scripts/import-lierda.mjs';

const api = 'https://api.github.com/repos/tangeai/xiaotai-lierda/releases?per_page=100&page=';
const downloads = 'https://github.com/tangeai/xiaotai-lierda/releases/download/';
const filename = 'release_lite.binpkg';
const tag = 'lite-v1.0.0';
const lite = 'lierda-ec718pm-lite';
const voicePro = 'lierda-ec718pm-pro';
const video = 'lierda-ec718hm-pro';
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

test('the shared Pro board ignores a legacy test manifest and non-stable release tags', async (t) => {
  const path = await directory(t);
  const oldManifest = JSON.stringify({ version: 'repair3' });
  await writeFile(join(path, 'pro.json'), oldManifest);
  const { boards, failed } = await collectLierdaBoards(path, {
    includePrerelease: true,
    fetcher: async (url) => {
      assert.equal(url, api + '1');
      return Response.json([
        { tag_name: '0.2.0' }, { tag_name: 'pro-v1.0.0-rc.1' },
        { tag_name: 'pro-v1.0.0', draft: true }, { tag_name: 'pro-v2.0.0', prerelease: true },
      ]);
    },
  });
  assert.equal(failed, false);
  assert.deepEqual(boards.find((board) => board.slug === video).releases, []);
  assert.equal(await readFile(join(path, 'pro.json'), 'utf8'), oldManifest);
  assert.equal(await readFile(join(path, 'lite.json'), 'utf8'), 'previous manifest');
});

test('a broken stable Pro release keeps the previously published catalog intact', async (t) => {
  const path = await directory(t);
  const previous = { slug: 'lierda-pro', releases: [{ version: '1.0.0' }] };
  // Valid BINPKG magic, four-image header and hash, but missing EC718HM product metadata.
  const binary = Buffer.alloc(52 + 364);
  binary.write('111\0\0\0\0\0bpkg');
  binary.writeUInt32LE(4, 16);
  binary.write('SHA256', 20);
  const proTag = 'pro-v1.1.0';
  const pkg = asset('pro.binpkg', binary, proTag);
  const checksum = Buffer.from(digest(binary) + '  pro.binpkg\n');
  const sums = asset('SHA256SUMS.txt', checksum, proTag);
  const errors = t.mock.method(console, 'error', () => {});
  const { boards, failed } = await collectLierdaBoards(path, {
    previousBoards: [previous],
    fetcher: async (url) => {
      if (url === api + '1') return Response.json([{ tag_name: proTag, assets: [pkg, sums] }]);
      if (url === sums.browser_download_url) return new Response(checksum);
      assert.equal(url, pkg.browser_download_url);
      return new Response(binary);
    },
  });
  assert.equal(failed, true);
  assert.match(errors.mock.calls[0].arguments[0], /EC718HM_PRD/);
  assert.deepEqual(boards.find((board) => board.slug === video).releases, previous.releases);
  assert.deepEqual(await readdir(path), ['lite.json']);
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

test('one release routes distinct board versions to their own files and checksum lines', async (t) => {
  const path = await directory(t);
  const version = 'v1.1.0';
  const contents = new Map([
    [`${version}-${lite}.binpkg`, Buffer.from('invalid lite package')],
    [`v1.0.0-${voicePro}.binpkg`, Buffer.from('invalid PM Pro package')],
    ['unrelated.binpkg', Buffer.from('unused')],
  ]);
  const checksums = Buffer.from([...contents].map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n'));
  const packages = [...contents].map(([name, bytes]) => asset(name, bytes, version));
  const sums = asset('SHA256SUMS.txt', checksums, version);
  const downloaded = [];
  t.mock.method(console, 'error', () => {});
  const previousBoards = [lite, voicePro, video].map(slug => ({ slug, releases: [{ version: '1.0.0' }] }));
  const { failed, boards } = await collectLierdaBoards(path, {
    previousBoards,
    fetcher: async url => {
      if (url === api + '1') return Response.json([{ tag_name: version, assets: [...packages, sums] }]);
      if (url === sums.browser_download_url) return new Response(checksums);
      const pkg = packages.find(item => item.browser_download_url === url);
      assert.ok(pkg);
      downloaded.push(pkg.name);
      return new Response(contents.get(pkg.name));
    },
  });
  assert.deepEqual(downloaded, [`${version}-${lite}.binpkg`, `v1.0.0-${voicePro}.binpkg`]);
  assert.equal(failed, true);
  assert.deepEqual(boards.map(b => b.releases), [previousBoards[0].releases, previousBoards[1].releases, []]);
  assert.deepEqual(await readdir(path), ['lite.json']);
});

test('ambiguous, noncanonical or malformed board versions retain the previous board', async (t) => {
  const path = await directory(t);
  const previous = { slug: voicePro, releases: [{ version: 'old' }] };
  const errors = t.mock.method(console, 'error', () => {});
  for (const [names, error] of [
    [[`v1.0.0-${voicePro}.binpkg`, `v0.1.0-${voicePro}.binpkg`], /包含多个/],
    [[`v01.0.0-${voicePro}.binpkg`], /文件名无效/],
    [[`v1.0.0-${voicePro.toUpperCase()}.binpkg`], /文件名无效/],
    [[`pro-v1.0.0-${voicePro}.binpkg`], /文件名无效/],
  ]) {
    const result = await collectLierdaBoards(path, {
      previousBoards: [previous],
      fetcher: async (url) => {
        assert.equal(url, api + '1');
        return Response.json([{ tag_name: 'v2.0.0', assets: names.map(name => ({ name })) }]);
      },
    });
    assert.equal(result.failed, true);
    assert.match(errors.mock.calls.at(-1).arguments[0], error);
    assert.deepEqual(result.boards.find(b => b.slug === voicePro).releases, previous.releases);
    assert.deepEqual(result.boards.find(b => b.slug === lite).releases, []);
  }
});

test('the shared catalog queries the repository once and keeps all three empty board selectors', async (t) => {
  const firmwareDir = await directory(t);
  const calls = [];
  const { boards, failed } = await collectLierdaBoards(firmwareDir, {
    fetcher: async (url) => {
      calls.push(url);
      return Response.json([
        { tag_name: 'lite-v1.0.1', prerelease: true },
        { tag_name: 'pro-v1.0.2', prerelease: true },
        { tag_name: 'pro-v2.0.0', draft: true },
        { tag_name: '0.2.0' },
      ]);
    },
  });
  assert.equal(failed, false);
  assert.deepEqual(calls, [api + '1']);
  assert.deepEqual(boards.map(({ slug, chip, modem, modempkg, flash_bytes, releases }) => (
    [slug, chip, modem, modempkg, flash_bytes, releases]
  )), [
    [lite, 'EC718PM', 'NT26F6D0', 'F6D_D', 0x400000, []],
    [voicePro, 'EC718PM', 'NT26F6D0', 'F6D_D', 0x400000, []],
    [video, 'EC718HM', 'NT26F9D0', 'F9D_D', 0x800000, []],
  ]);
  assert.equal(await readFile(join(firmwareDir, 'lite.json'), 'utf8'), 'previous manifest');
  assert.deepEqual(await readdir(firmwareDir), ['lite.json']);
});

test('an invalid opt-in Lite release retains only its board while Pro drops old rows on a successful sync', async (t) => {
  const path = await directory(t);
  const previousBoards = [
    { slug: 'lierda-lite', releases: [{ version: '1.0.0' }] },
    { slug: 'lierda-pro', releases: [{ version: 'old' }] },
  ];
  const result = await collectLierdaBoards(path, {
    previousBoards, includePrerelease: true,
    fetcher: async () => Response.json([
      { tag_name: 'lite-v1.0.1', prerelease: true, assets: [] },
      { tag_name: 'pro-v1.0.1', prerelease: true, assets: [] },
    ]),
  });
  assert.equal(result.failed, true);
  assert.deepEqual(result.boards.find(b => b.slug === lite).releases, previousBoards[0].releases);
  assert.deepEqual(result.boards.find(b => b.slug === video).releases, []);
});

test('a failed release listing retains both boards and reports failure', async (t) => {
  const path = await directory(t);
  const previousBoards = [
    { slug: 'lierda-lite', releases: [{ version: '1.0.0' }] },
    { slug: 'lierda-pro', releases: [] },
  ];
  const result = await collectLierdaBoards(path, {
    previousBoards, fetcher: async () => new Response(null, { status: 403 }),
  });
  assert.equal(result.failed, true);
  assert.deepEqual(result.boards.map(b => [b.slug, b.releases]), [
    [lite, previousBoards[0].releases], [video, previousBoards[1].releases],
  ]);
});
