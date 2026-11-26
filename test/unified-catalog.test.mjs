import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateCatalog } from '../scripts/generate-boards.mjs';
import curatedCatalog from '../boards.json' with { type: 'json' };

const api = 'https://api.github.com/repos/tangeai/';
const releaseList = (repository) => api + repository + '/releases?per_page=100&page=1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lierdaSlugs = ['lierda-ec718pm-lite', 'lierda-ec718pm-pro', 'lierda-ec718hm-pro'];

async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'xiaotai-unified-catalog-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const routes = new Map();
  const releases = [];
  const board = { id: 'bk-fixture', model: 'BK fixture', target: 'BK7258' };
  const blob = Buffer.from(JSON.stringify(board)).toString('base64');
  routes.set(api + 'xiaotai/git/blobs/board', () => Response.json({ encoding: 'base64', content: blob }));
  for (const [tag, prerelease] of [['v1', false], ['v2', true]]) {
    const filename = tag + '_bk-fixture_all-app.bin';
    const bytes = Buffer.from(tag + ' test image');
    const url = 'https://github.com/tangeai/xiaotai/releases/download/' + tag + '/' + filename;
    releases.push({
      tag_name: tag, prerelease, draft: false, published_at: prerelease ? '2026-02-01' : '2026-01-01',
      assets: [{ name: filename, size: bytes.length, state: 'uploaded', digest: 'sha256:' + hash(bytes), browser_download_url: url }],
    });
    routes.set(api + 'xiaotai/git/trees/' + tag + '?recursive=1', () => Response.json({
      tree: [{ type: 'blob', path: 'boards/bk7258/demo/board.json', sha: 'board' }],
    }));
    routes.set(url, () => new Response(bytes));
  }
  routes.set(releaseList('xiaotai'), () => Response.json(releases));
  routes.set(releaseList('xiaotai-esp32'), () => Response.json([]));
  routes.set(releaseList('xiaotai-lierda'), () => Response.json([]));
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(routes.has(String(url)), 'unexpected request: ' + url);
    return routes.get(String(url))();
  });
  const readCatalog = async () => JSON.parse(await readFile(join(output, 'boards.json'), 'utf8'));
  return { output, routes, readCatalog };
}

test('one catalog publishes all board families, preserving the old BIN paths and prerelease option', async (t) => {
  const { output, readCatalog } = await fixture(t);
  assert.equal((await generateCatalog(output)).failed, false);
  const catalog = await readCatalog();
  const bk = catalog.boards.find(({ chip }) => chip === 'BK7258');
  assert.equal(bk.releases.length, 1);
  assert.equal(bk.releases[0].bin_url, './firmware/v1_bk-fixture_all-app.bin');
  assert.equal(hash(await readFile(join(output, bk.releases[0].bin_url))), bk.releases[0].sha256);
  for (const slug of lierdaSlugs) {
    assert.deepEqual(catalog.boards.find((board) => board.slug === slug)?.releases, []);
  }
  assert.equal((await generateCatalog(output, true)).failed, false);
  const withTesting = (await readCatalog()).boards.find((board) => board.slug === bk.slug);
  assert.equal(withTesting.releases.length, 2);
  assert.deepEqual(withTesting.releases.filter((release) => release.recommended), bk.releases);
  assert.match(withTesting.releases.find((release) => !release.recommended).version, /测试版/);
});

test('sync migrates a custom platform name once and shares it with newly discovered boards', async t => {
  const { output, readCatalog } = await fixture(t);
  const lite = curatedCatalog.boards.find(board => board.slug === lierdaSlugs[0]);
  await writeFile(join(output, 'boards.json'), JSON.stringify({
    boards: [{ ...lite, platform_name: '移芯语音板' }],
  }));
  for (let run = 0; run < 2; run++) {
    assert.equal((await generateCatalog(output)).failed, false);
    const { platforms, boards } = await readCatalog();
    assert.deepEqual(platforms.filter(row => row.platform === 'lierda'), [
      { platform: 'lierda', platform_name: '移芯语音板' },
    ]);
    assert.equal(boards.filter(board => board.platform === 'lierda').length, 3);
    assert.ok(boards.every(board => !Object.hasOwn(board, 'platform_name')));
  }
});

test('a failed source retains its last good rows while a successful source updates its rows', async (t) => {
  const { output, routes, readCatalog } = await fixture(t);
  await generateCatalog(output);
  const catalog = await readCatalog();
  const pro = catalog.boards.find((board) => board.slug === 'lierda-ec718hm-pro');
  const bytes = Buffer.from('existing verified release');
  const sha256 = hash(bytes);
  const filename = 'pro-v1.0.0-' + sha256 + '.binpkg';
  pro.releases.push({
    version: '1.0.0', status: 'published', recommended: true,
    bin_url: './firmware/' + filename, sha256, byte_length: bytes.length, source_filename: '1.0.0_pro.binpkg',
  });
  await writeFile(join(output, 'firmware', filename), bytes);
  const oldSlug = 'lierda-pro';
  await writeFile(join(output, 'boards.json'), JSON.stringify({
    boards: catalog.boards.map(board => board === pro ? { ...board, slug: oldSlug } : board),
  }));

  routes.set(releaseList('xiaotai-lierda'), () => Response.json([{ tag_name: 'pro-v2.0.0', assets: [] }]));
  assert.equal((await generateCatalog(output, true)).failed, true);
  const partial = await readCatalog();
  assert.deepEqual(partial.boards.find((board) => board.slug === pro.slug).releases, pro.releases);
  assert.ok(!partial.boards.some(board => board.slug === oldSlug));
  assert.deepEqual(partial.boards.find(board => board.slug === 'lierda-ec718pm-pro').releases, []);
  const bk = partial.boards.find((board) => board.chip === 'BK7258');
  assert.equal(bk.releases.length, 2);

  routes.set(releaseList('xiaotai-lierda'), () => Response.json([]));
  routes.set(releaseList('xiaotai'), () => new Response(null, { status: 403 }));
  assert.equal((await generateCatalog(output, true)).failed, true);
  const recovered = await readCatalog();
  assert.deepEqual(recovered.boards.find((board) => board.slug === pro.slug).releases, []);
  assert.deepEqual(recovered.boards.find((board) => board.slug === bk.slug), bk);
});

test('sync retains deployed curated BINs and display metadata without restoring other old releases', async t => {
  const { output, readCatalog } = await fixture(t);
  await generateCatalog(output);
  const { boards } = await readCatalog();
  const bk = boards.find(board => board.chip === 'BK7258');
  bk.releases[0].version += '（特别版）';
  bk.releases[0].embedded_version = '1.2.0+build.112';
  const curated = structuredClone(curatedCatalog.boards.find(board => board.slug === 'xmini-c3-v3'));
  const pinned = curated.releases[0];
  curated.releases.push(
    { ...pinned, version: 'wrong hash', sha256: 'c'.repeat(64) },
    { ...pinned, version: 'wrong URL', bin_url: './firmware/other.bin' },
  );
  const offline = structuredClone(curatedCatalog.boards.find(board => board.slug === 'mz28-ai-ppd-v12'));
  offline.releases[0].status = 'offline';
  const withdrawn = { ...curated, slug: 'previously-generated', releases: [pinned] };
  await writeFile(join(output, 'boards.json'), JSON.stringify({ boards: [...boards, curated, offline, withdrawn] }));

  for (let run = 0; run < 2; run++) {
    assert.equal((await generateCatalog(output)).failed, false);
    const result = (await readCatalog()).boards;
    assert.deepEqual(result.find(board => board.slug === bk.slug), bk);
    assert.deepEqual(result.find(board => board.slug === curated.slug), { ...curated, releases: [pinned] });
    assert.ok(!result.some(board => board.slug === offline.slug || board.slug === withdrawn.slug));
  }
  bk.releases[0].status = 'draft';
  await writeFile(join(output, 'boards.json'), JSON.stringify({ boards: [bk] }));
  assert.equal((await generateCatalog(output, true)).failed, false);
  const versions = (await readCatalog()).boards.find(board => board.slug === bk.slug).releases;
  assert.equal(versions.find(release => release.version === bk.releases[0].version).status, 'draft');
  assert.deepEqual(versions.filter(release => release.recommended).map(release => release.status), ['published']);
});

test('an upstream outage cannot publish a placeholder catalog or reorder the previous catalog', async (t) => {
  const { output, routes, readCatalog } = await fixture(t);
  for (const repo of ['xiaotai', 'xiaotai-esp32', 'xiaotai-lierda']) {
    routes.set(releaseList(repo), () => new Response(null, { status: 403 }));
  }
  assert.deepEqual(await generateCatalog(output), { boards: [], failed: true });
  await assert.rejects(readCatalog(), { code: 'ENOENT' });

  const previous = { boards: [
    { slug: 'lierda-pro', chip: 'EC718HM', releases: [] },
    { slug: 'bk-fixture', chip: 'BK7258', releases: [] },
  ] };
  const json = JSON.stringify(previous);
  await writeFile(join(output, 'boards.json'), json);
  assert.deepEqual(await generateCatalog(output), { boards: previous.boards, failed: true });
  assert.equal(await readFile(join(output, 'boards.json'), 'utf8'), json);
});

test('an incomplete catalog is rebuilt only after every source succeeds', async (t) => {
  const { output, routes, readCatalog } = await fixture(t);
  const catalogPath = join(output, 'boards.json');
  const releaseURL = releaseList('xiaotai-lierda');
  const healthy = routes.get(releaseURL);
  for (const damaged of ['{"boards":[', '{"boards":[null]}', '{"boards":[{"slug":"bk-fixture"}]}']) {
    await writeFile(catalogPath, damaged);
    routes.set(releaseURL, () => new Response(null, { status: 403 }));
    assert.equal((await generateCatalog(output)).failed, true);
    assert.equal(await readFile(catalogPath, 'utf8'), damaged);

    routes.set(releaseURL, healthy);
    assert.equal((await generateCatalog(output)).failed, false);
    assert.deepEqual((await readCatalog()).boards.map(board => board.slug), ['bk-fixture', ...lierdaSlugs]);
  }
});

test('a UTF-8 BOM in an existing catalog preserves its boards during a partial sync', async (t) => {
  const { output, routes, readCatalog } = await fixture(t);
  const previous = { slug: 'bk-fixture', chip: 'BK7258', releases: [] };
  await writeFile(join(output, 'boards.json'), '\uFEFF' + JSON.stringify({ boards: [previous] }));
  routes.set(releaseList('xiaotai'), () => new Response(null, { status: 403 }));
  assert.equal((await generateCatalog(output)).failed, true);
  const { boards } = await readCatalog();
  assert.deepEqual(boards[0], { ...previous, platform: 'bk7258' });
  assert.deepEqual(boards.slice(1).map(board => board.slug), lierdaSlugs);
});
