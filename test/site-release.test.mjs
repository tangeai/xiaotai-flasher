import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIERDA_AGENTBOOT_PATH } from '../src/lierda-agentboot.mjs';
import { lierdaAgentBootInfo } from '../scripts/lierda-agentboot-file.mjs';

const script = fileURLToPath(new URL('../scripts/site-release.mjs', import.meta.url));
const boardsUrl = './firmware-catalog.json';
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

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

test('release checks isolate Lierda assets and preserve releases without AgentBoot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'xiaotai-loader-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const site = join(root, 'web-flasher');
  const release = 'xiaotai-flasher-20261122T000001Z-r1';
  const target = join(root, '.web-flasher-releases', release);
  makeBuild(target, 'entry');
  symlinkSync(target, site, process.platform === 'win32' ? 'junction' : 'dir');
  const info = join(target, 'release-info.json');
  const loader = join(target, LIERDA_AGENTBOOT_PATH);
  assert.equal(run('verify', target).status, 0);
  assert.equal(run('verify', target, '--require-lierda-agentboot').status, 1);
  assert.equal(run('matches', site, 'entry', boardsUrl).status, 0);
  const privateFile = join(dirname(loader), 'local-debug.txt');
  mkdirSync(dirname(loader));
  writeFileSync(privateFile, 'local fixture');
  assert.equal(run('verify', target).status, 1);
  assert.equal(run('publish', site, 'xiaotai-flasher-20261126T000000Z-private', target).status, 2);
  rmSync(privateFile);

  writeFileSync(info, JSON.stringify({ commit: 'entry', lierda_agentboot: lierdaAgentBootInfo }));
  assert.equal(run('verify', target).status, 1);
  assert.equal(run('publish', site, 'xiaotai-flasher-20261126T000000Z-incomplete', target).status, 2);
  assert.equal(run('matches', site, 'entry', boardsUrl).status, 1);
  assert.equal(run('rollback', site, release).status, 2);
  assert.doesNotMatch(run('status', site).stdout, /可用版本\n[^]*-r1/);

  const vendorFile = new URL('../public/' + LIERDA_AGENTBOOT_PATH, import.meta.url);
  await t.test('verifies the bundled AgentBoot before accepting the release', { skip: !existsSync(vendorFile) }, () => {
    copyFileSync(vendorFile, loader);
    assert.equal(run('verify', target).status, 0);
    assert.equal(run('verify', target, '--require-lierda-agentboot').status, 0);
    assert.equal(run('matches', site, 'entry', boardsUrl).status, 0);
    const corrupt = readFileSync(loader);
    corrupt[0] ^= 1;
    writeFileSync(loader, corrupt);
    assert.equal(run('verify', target).status, 1);
    assert.equal(run('matches', site, 'entry', boardsUrl).status, 1);
    assert.equal(run('rollback', site, release).status, 2);
    rmSync(loader);
  });

  writeFileSync(info, JSON.stringify({ commit: 'entry' }));
  assert.equal(run('verify', target).status, 0);
  assert.equal(run('matches', site, 'entry', boardsUrl).status, 0);
  assert.equal(run('rollback', site, release).status, 0);
  assert.match(run('status', site).stdout, /可用版本\n[^]*-r1/);
});
