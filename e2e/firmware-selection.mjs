import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const catalog = JSON.parse(await readFile(new URL('../boards.json', import.meta.url), 'utf8'));
let server;
let browser;
let base;

before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openPage(t, slug, data, catalogDelay) {
  const page = await browser.newPage({ locale: 'zh-CN' });
  t.after(() => page.close());
  await page.route('**/firmware-catalog.json*', async route => {
    await catalogDelay;
    await route.fulfill({ json: data });
  });
  await page.goto(base + '?board=' + slug, { waitUntil: 'domcontentloaded' });
  return page;
}

function chooseSource(page, name, value) {
  return page.locator('label').filter({ has: page.locator(`input[name="${name}"][value="${value}"]`) }).click();
}

test('Lierda retains the chosen BINPKG when the catalog assigns its platform', async t => {
  const data = structuredClone(catalog);
  data.platforms.find(group => group.platform === 'lierda').platform = 'audio';
  for (const board of data.boards) {
    if (board.platform === 'lierda') board.platform = 'audio';
  }

  let resume;
  const delay = new Promise(resolve => { resume = resolve; });
  const page = await openPage(t, 'lierda-lite', data, delay);
  const file = page.locator('#lierda-binpkg');
  try {
    await chooseSource(page, 'lierda-source', 'local');
    await file.setInputFiles({ name: 'chosen.binpkg', mimeType: 'application/octet-stream', buffer: Buffer.from('chosen package') });
  } finally {
    resume();
  }
  await page.waitForFunction(() => document.querySelector('.device-bar select').value === 'audio');
  assert.match(await page.locator('#start-hint').innerText(), /已选择固件包/);
  assert.deepEqual(await file.evaluate(async input => {
    const selected = input.files[0];
    return selected && [selected.name, await selected.text()];
  }), ['chosen.binpkg', 'chosen package']);
  assert.ok(await page.locator('#start').isDisabled());
});

for (const platform of ['esp32', 'bk7258']) {
  test(platform + ' clears the visible BIN when changing the online board', async t => {
    const [first, second] = catalog.boards.filter(board => board.platform === platform);
    const page = await openPage(t, first.slug, catalog);
    await page.locator('#board option[value="' + second.slug + '"]').waitFor({ state: 'attached' });
    const file = page.locator('#merged-bin');
    const bin = { name: 'before.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('example') };
    await chooseSource(page, 'source', 'local');
    await file.setInputFiles(bin);
    await chooseSource(page, 'source', 'official');
    await page.locator('#board').selectOption(second.slug);
    await chooseSource(page, 'source', 'local');
    assert.match(await page.locator('#start-hint').innerText(), /请选择完整 BIN 镜像/);
    assert.equal(await file.evaluate(input => input.files.length), 0);
    await file.setInputFiles(bin);
    assert.match(await page.locator('#start-hint').innerText(), /连接开发板后即可开始烧录/);
  });
}
