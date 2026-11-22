import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/site-release.mjs', import.meta.url));
const boardsUrl = './firmware-catalog.json';

function makeBuild(path, entry) {
  mkdirSync(join(path, 'assets'), { recursive: true });
  writeFileSync(join(path, 'index.html'), `<script type="module" src="./assets/${entry}.js"></script>`);
  writeFileSync(join(path, 'boards-source.json'), JSON.stringify({ boards_url: boardsUrl }));
  writeFileSync(join(path, 'release-info.json'), JSON.stringify({ commit: entry }));
  writeFileSync(join(path, 'assets', `${entry}.js`), `// ${entry}`);
}

test('release checks require the built entry and preserve assets across updates and rollbacks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'xiaotai-site-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const site = join(root, 'web-flasher');
  const release1 = 'xiaotai-flasher-20261122T000001Z-r1';
  const release2 = 'xiaotai-flasher-20261122T000002Z-r2';
  const release3 = 'xiaotai-flasher-20261122T000003Z-r3';
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  for (const [name, entry] of [[release1, 'entry1'], [release2, 'entry2'], [release3, 'entry3']]) {
    const build = join(root, entry);
    makeBuild(build, entry);
    const result = run('publish', site, name, build);
    assert.equal(result.status, 0, result.stderr);
  }

  for (const entry of ['entry1', 'entry2', 'entry3']) {
    assert.equal(readFileSync(join(site, 'assets', `${entry}.js`), 'utf8'), `// ${entry}`);
  }
  assert.equal(run('matches', site, 'entry3', boardsUrl).status, 0);

  rmSync(join(site, 'assets', 'entry3.js'));
  assert.equal(run('matches', site, 'entry3', boardsUrl).status, 1);
  assert.equal(run('rollback', site, release3).status, 2);
  assert.doesNotMatch(run('status', site).stdout, /可用版本\n[^]*-r3/);

  const rollback = run('rollback', site, release1);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readFileSync(join(site, 'assets', 'entry2.js'), 'utf8'), '// entry2');

  const emptyBuild = join(root, 'empty');
  makeBuild(emptyBuild, 'empty');
  rmSync(join(emptyBuild, 'assets', 'empty.js'));
  assert.equal(run('verify', emptyBuild).status, 1);
});
