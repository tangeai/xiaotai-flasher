import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistLierdaFlashBackup } from '../src/lierda-workflow.mjs';

test('Flash backup requires durable readback before reporting success', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const bytes = new Uint8Array(0x400000);
  bytes.set([0x41, 0x18, 0x97, 0x54]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let saved;
  let removed = false;
  let corrupt = false;
  const handle = {
    async createWritable() {
      return { async write(data) { saved = data.slice(); }, async close() {}, async abort() {} };
    },
    async getFile() {
      if (corrupt) saved[0] ^= 0xff;
      return { size: saved.length, async arrayBuffer() { return saved.buffer; } };
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { async getDirectory() {
      return { async getDirectoryHandle() {
        return { async getFileHandle() { return handle; }, async removeEntry() { removed = true; } };
      } };
    } } },
  });
  try {
    const backup = await persistLierdaFlashBackup(bytes, digest, 'lite');
    assert.equal(backup.sha256, digest);
    assert.match(backup.name, /^lierda-lite-.*\.bin$/);
    assert.equal(removed, false);
    await assert.rejects(persistLierdaFlashBackup(bytes, digest, 'pro-f9'), /8 MiB Flash/);
    const proBytes = new Uint8Array(0x800000);
    proBytes.set(bytes);
    proBytes[0x7fffff] = 0x29;
    const proDigest = createHash('sha256').update(proBytes).digest('hex');
    const proBackup = await persistLierdaFlashBackup(proBytes, proDigest, 'pro-f9');
    assert.equal(proBackup.sha256, proDigest);
    assert.match(proBackup.name, /^lierda-pro-f9-.*\.bin$/);
    assert.equal(saved.length, proBytes.length);
    await assert.rejects(persistLierdaFlashBackup(bytes, digest, 'pro-pm'), /8 MiB Flash/);
    const voiceBackup = await persistLierdaFlashBackup(proBytes, proDigest, 'pro-pm');
    assert.match(voiceBackup.name, /^lierda-pro-pm-internal-spi1-.*\.bin$/);
    assert.deepEqual(saved, proBytes);
    corrupt = true;
    await assert.rejects(persistLierdaFlashBackup(bytes, digest, 'lite'), /SHA-256 不一致/);
    assert.equal(removed, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});
