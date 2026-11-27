import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { connectLierda } from '../src/lierda.mjs';
import { getLierdaHardwareProfile } from '../src/lierda-package.mjs';
import { persistLierdaFlashBackup } from '../src/lierda-workflow.mjs';
import { pmProRecoveryStore, readLierdaFlashIdentity } from '../src/lierda-recovery.mjs';
import { makePmFixture, simulateHmFlash } from './fixtures/lierda-hm.mjs';
import { downloadPort, lpcWire, useSyntheticAgent } from './fixtures/lierda-port.mjs';

function originStorage(t) {
  const files = new Map();
  const folder = {
    async *entries() {
      for (const name of files.keys()) yield [name, await this.getFileHandle(name)];
    },
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(name, new Blob([]));
      }
      return {
        async getFile() { return files.get(name); },
        async createWritable() {
          let contents;
          return {
            async write(bytes) { contents = new Blob([bytes]); },
            async close() { files.set(name, contents); },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  const storage = { async getDirectory() { return { async getDirectoryHandle() { return folder; } }; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  });
  return files;
}

function setup(t, uid = Buffer.from('21c5951cdb97a084', 'hex')) {
  const files = originStorage(t);
  const pins = new Map();
  const profile = getLierdaHardwareProfile('pro-pm');
  const board = makePmFixture(profile, pins);
  useSyntheticAgent(t, pins);
  const flash = simulateHmFlash(board.memory, { external: board.external, uid });
  const reconnect = () => connectLierda(downloadPort(null, { flash }), { recovery: pmProRecoveryStore });
  const saveBackup = async (bytes, digest) => {
    const backup = await persistLierdaFlashBackup(bytes, digest, 'pro-pm');
    flash.markBackupSaved();
    return backup;
  };
  return { ...board, files, uid, flash, reconnect, saveBackup };
}

test('PM Pro recovery survives a closed page, binds the exact device, original backup and package', async t => {
  const { files, uid, flash, reconnect, saveBackup, firmware, memory, external, resource } = setup(t);
  const identity = createHash('sha256').update(uid).digest('hex');
  const before = Buffer.concat([memory, external]);
  const session = await reconnect();
  const reply = flash.reply;
  flash.reply = frame => {
    const result = reply(frame);
    if (frame[2] === 0x4c && frame[0] === 0x10) {
      flash.reply = reply;
      throw new Error('Power loss after erasing the first APP sector');
    }
    return result;
  };
  await assert.rejects(session.writeLierda(firmware, { saveBackup }), /Power loss/);
  await session.close();
  const journal = await pmProRecoveryStore.find(identity);
  assert.equal(journal.stage, 'internal');
  const originalFile = files.get(journal.name);
  assert.ok(before.equals(new Uint8Array(await originalFile.arrayBuffer())));
  assert.deepEqual(memory.subarray(0x2a6000, 0x2a6004), Buffer.alloc(4, 0xff));

  async function remainsBlocked() {
    const fresh = await reconnect();
    try {
      assert.equal(fresh.lierdaModel, null);
      await assert.rejects(fresh.writeLierda(firmware, { saveBackup: assert.fail }));
    } finally { await fresh.close(); }
  }
  const previousId = Buffer.from(uid);
  uid[0] ^= 1;
  await remainsBlocked();
  uid.fill(0xff);
  await remainsBlocked();
  previousId.copy(uid);
  memory[0x19100] ^= 1; // protected factory bytes
  await remainsBlocked();
  memory[0x19100] ^= 1;
  files.set(journal.name, new Blob([new Uint8Array(0x800000)]));
  await remainsBlocked();
  files.set(journal.name, originalFile);

  const fresh = await reconnect();
  t.after(() => fresh.close());
  assert.equal(fresh.lierdaModel, 'pro-pm');
  assert.equal(fresh.lierdaRecoveryBackup.name, journal.name);
  const other = Buffer.from(firmware.bytes);
  other[50] ^= 1; // same valid images, different container digest
  await assert.rejects(fresh.writeLierda({ ...firmware, bytes: other, sha256: undefined },
    { saveBackup: assert.fail }), /上次中断的固件/);
  const result = await fresh.writeLierda(firmware, { saveBackup: assert.fail });
  assert.deepEqual(result.verifiedImages.map(x => x.role), ['EXT', 'APP']);
  assert.equal(result.backupHash, journal.digest);
  assert.equal(await pmProRecoveryStore.find(identity), null);
  assert.equal(files.size, 1);
  assert.equal(files.get(journal.name), originalFile);
  assert.ok(external.equals(resource));
});

test('an interrupted external write keeps the original backup and cannot identify an erased APP', async t => {
  const { files, flash, uid, memory, reconnect, saveBackup, firmware } = setup(t);
  const session = await reconnect();
  const reply = flash.reply;
  flash.reply = frame => {
    if (frame[2] === 0x4c && frame[0] === 0xe0 && frame.readUInt32LE(8) === 0x142) {
      flash.reply = reply;
      throw new Error('Power loss at SPI1 programming');
    }
    return reply(frame);
  };
  await assert.rejects(session.writeLierda(firmware, { saveBackup }), /Power loss/);
  await session.close();
  const journal = await pmProRecoveryStore.find(createHash('sha256').update(uid).digest('hex'));
  assert.equal(journal.stage, 'external');
  const saved = files.get(journal.name);
  const appHeader = Buffer.from(memory.subarray(0x2a6000, 0x2a6018));
  memory.fill(0xff, 0x2a6000, 0x2a6018);
  const damaged = await reconnect();
  assert.equal(damaged.lierdaModel, null, 'external stage did not authorize internal erasure');
  await damaged.close();
  appHeader.copy(memory, 0x2a6000);
  const intact = await reconnect();
  t.after(() => intact.close());
  assert.equal(intact.lierdaModel, 'pro-pm');
  assert.equal(intact.lierdaRecoveryPackageSha, journal.packageSha);
  const result = await intact.writeLierda(firmware, { saveBackup: assert.fail });
  assert.equal(result.backupHash, journal.digest);
  assert.equal(intact.lierdaRecoveryPackageSha, undefined);
  assert.equal(files.size, 1);
  assert.equal(files.get(journal.name), saved);
});

test('an intact PM Pro can retain new user files across a second interruption during APP erasure', async t => {
  const { flash, files, uid, memory, external, firmware, reconnect, saveBackup } = setup(t);
  const identity = createHash('sha256').update(uid).digest('hex');
  const { fsStart, fsSize } = getLierdaHardwareProfile('pro-pm').app;
  const initial = Buffer.concat([memory, external]);
  const reply = flash.reply;
  function interruptAfter(command) {
    flash.reply = frame => {
      const result = reply(frame);
      if (frame[2] === 0x4c && frame[0] === command) {
        flash.reply = reply;
        throw new Error('Power loss');
      }
      return result;
    };
  }

  const first = await reconnect();
  interruptAfter(0x44); // SPI1 programmed, internal application is still runnable.
  await assert.rejects(first.writeLierda(firmware, { saveBackup }), /Power loss/);
  await first.close();
  const pending = await pmProRecoveryStore.find(identity);
  assert.equal(pending.stage, 'external');
  await assert.rejects(pmProRecoveryStore.replace(identity, pending,
    { ...pending, fsDigest: 'a'.repeat(64) }), /续刷记录无效/);
  await assert.rejects(pmProRecoveryStore.replace(identity, pending,
    { ...pending, stage: 'internal', fsDigest: 'incomplete' }), /续刷记录无效/);
  const originalFile = files.get(pending.name);
  memory[fsStart + 9] ^= 0x55;
  const updatedFs = Buffer.from(memory.subarray(fsStart, fsStart + fsSize));

  const second = await reconnect();
  assert.equal(second.lierdaModel, 'pro-pm');
  memory[0x3f4000] ^= 1; // Outside the user FS, even while the original APP is intact.
  const externalWrites = flash.externalWritten.length;
  await assert.rejects(second.writeLierda(firmware, { saveBackup: assert.fail }), /保留区/);
  assert.equal(flash.externalWritten.length, externalWrites);
  memory[0x3f4000] ^= 1;
  interruptAfter(0x10); // The next connection must recover without a working APP.
  await assert.rejects(second.writeLierda(firmware, { saveBackup: assert.fail }), /Power loss/);
  await second.close();
  const advanced = await pmProRecoveryStore.find(identity);
  assert.equal(advanced.stage, 'internal');
  assert.equal(advanced.fsDigest, createHash('sha256').update(updatedFs).digest('hex'));

  memory[fsStart + 9] ^= 1;
  const changed = await reconnect();
  assert.equal(changed.lierdaModel, null, 'an erased APP cannot recapture a different FS');
  await changed.close();
  memory[fsStart + 9] ^= 1;
  const last = await reconnect();
  t.after(() => last.close());
  assert.equal(last.lierdaModel, 'pro-pm');
  const result = await last.writeLierda(firmware, { saveBackup: assert.fail });
  assert.equal(result.backupHash, pending.digest);
  assert.equal(await pmProRecoveryStore.find(identity), null);
  assert.ok(updatedFs.equals(memory.subarray(fsStart, fsStart + fsSize)));
  assert.equal(files.get(pending.name), originalFile);
  assert.ok(initial.equals(new Uint8Array(await originalFile.arrayBuffer())));
});

for (const stopAt of ['擦除固件区域', '回读校验']) {
  test(`PM Pro resumes after the runnable APP updates user files at ${stopAt}`, async t => {
    const { files, flash, uid, memory, firmware, reconnect, saveBackup, app } = setup(t);
    const { address, capacity, fsStart } = getLierdaHardwareProfile('pro-pm').app;
    const identity = createHash('sha256').update(uid).digest('hex');
    const first = await reconnect();
    await assert.rejects(first.writeLierda(firmware, {
      saveBackup, onProgress(_, step) { if (step === stopAt) throw new Error('Power loss'); },
    }), /Power loss/);
    await first.close();
    const original = await pmProRecoveryStore.find(identity);
    const file = files.get(original.name);
    assert.equal(original.stage, 'internal');
    memory[fsStart + 11] ^= 1; // The original or newly installed APP ran before reconnecting.
    const userByte = memory[fsStart + 11];

    let resumed = await reconnect();
    t.after(() => resumed.close());
    assert.equal(resumed.lierdaModel, 'pro-pm');
    const writes = flash.externalWritten.length;
    const appTail = address + capacity - 1;
    memory[appTail] ^= 1; // The startup code still identifies as Pro, but the full APP differs.
    await assert.rejects(resumed.writeLierda(firmware, { saveBackup: assert.fail }), /保留区/);
    memory[appTail] ^= 1;
    memory[0x19100] ^= 1; // A changed user filesystem must never mask changed factory data.
    await assert.rejects(resumed.writeLierda(firmware, { saveBackup: assert.fail }), /保留区/);
    memory[0x19100] ^= 1;
    assert.deepEqual(await pmProRecoveryStore.find(identity), original);
    assert.equal(flash.externalWritten.length, writes);

    if (stopAt === '擦除固件区域') {
      const reply = flash.reply;
      flash.reply = frame => {
        const result = reply(frame);
        if (frame[0] === 0x10 && frame[2] === 0x4c) {
          flash.reply = reply;
          throw new Error('Power loss during resumed erase');
        }
        return result;
      };
      await assert.rejects(resumed.writeLierda(firmware, { saveBackup: assert.fail }), /resumed erase/);
      await resumed.close();
      resumed = await reconnect(); // APP is now incomplete; the newer FS checkpoint must already be durable.
      assert.equal(resumed.lierdaModel, 'pro-pm');
    }
    const result = await resumed.writeLierda(firmware, { saveBackup: assert.fail });
    assert.equal(result.backupHash, original.digest);
    assert.equal(memory[fsStart + 11], userByte);
    assert.ok(app.equals(memory.subarray(address, address + app.length)));
    assert.equal(await pmProRecoveryStore.find(identity), null);
    assert.equal(files.get(original.name), file);
  });
}

test('Flash identity accepts structured serials at factory response lengths and checks every reply', async () => {
  for (const uid of [Buffer.from('0101010101010102', 'hex'), Buffer.from('0001020304050607', 'hex'),
    Buffer.from('11221122112211221122112211221122', 'hex'), Buffer.alloc(32, 0x77)]) {
    assert.equal(await readLierdaFlashIdentity(lpcWire(frame => {
      assert.equal(frame.toString('hex'), '25004cb30200004f01e04f5088d1');
      return { data: uid };
    })), createHash('sha256').update(uid).digest('hex'));
  }
  for (const data of [Buffer.alloc(0), Buffer.of(0x20, 0x36), Buffer.alloc(8), Buffer.alloc(16, 0xff)]) {
    assert.equal(await readLierdaFlashIdentity(lpcWire(() => ({ data }))), null);
  }
  const data = Buffer.alloc(8, 0xff);
  await assert.rejects(readLierdaFlashIdentity(lpcWire(() => ({ data, damage: true }))), /CRC32/);
  await assert.rejects(readLierdaFlashIdentity(lpcWire(() => ({ data, status: 0x30 }))), /0x30/);
  await assert.rejects(readLierdaFlashIdentity(lpcWire(() => { throw new Error('timeout'); })), /timeout/);
});

test('an identified Pro with no usable UID keeps its original backup and only retries in the same session', async t => {
  const { files, uid, reconnect, firmware, saveBackup } = setup(t);
  uid.fill(0xff);
  const session = await reconnect();
  t.after(() => session.close());
  assert.equal(session.lierdaModel, 'pro-pm');
  const lines = [];
  await assert.rejects(session.writeLierda(firmware, {
    saveBackup, log: line => lines.push(line),
    onProgress(_, step) { if (step === '写入 SPI1 界面资源') throw new Error('pause before write'); },
  }), /pause before write/);
  assert.ok(lines.some(line => line.includes('保持当前连接')));
  assert.equal(session.lierdaRecoveryPackageSha, createHash('sha256').update(firmware.bytes).digest('hex'));
  assert.equal(files.size, 1);
  assert.equal(await pmProRecoveryStore.hasPending(), false);
  uid[0] = 0x12; // Must not switch a live session from unidentified to a persistent ID.
  await assert.rejects(session.writeLierda(firmware, { saveBackup: assert.fail }), /唯一标识/);
  uid.fill(0xff);
  const result = await session.writeLierda(firmware, { saveBackup: assert.fail });
  assert.deepEqual(result.verifiedImages.map(image => image.role), ['EXT', 'APP']);
  assert.equal(files.size, 1);
});

test('an intact Pro cannot fall back if any device has a pending journal or its valid ID disappears', async t => {
  const { files, flash, uid, reconnect, firmware, saveBackup } = setup(t);
  const session = await reconnect();
  t.after(() => session.close());
  const originalId = Buffer.from(uid);
  uid.fill(0);
  const another = 'pm-pro-' + 'f'.repeat(64) + '.json';
  files.set(another, new Blob(['{']));
  await assert.rejects(session.writeLierda(firmware, { saveBackup: assert.fail }), /唯一标识/);
  files.delete(another);
  originalId.copy(uid);
  await assert.rejects(session.writeLierda(firmware, {
    saveBackup, onProgress(_, step) { if (step === '备份原始 Flash') throw new Error('backup interrupted'); },
  }), /backup interrupted/);
  uid.fill(0xff);
  await assert.rejects(session.writeLierda(firmware, { saveBackup: assert.fail }), /唯一标识/);
  assert.deepEqual(flash.erased, []);
  assert.deepEqual(flash.written, []);
  assert.deepEqual(flash.externalWritten, []);
  assert.equal(files.size, 0);
});

test('a port failure while reading a known Pro UID aborts before backup or programming', async t => {
  const { files, flash, reconnect, firmware } = setup(t);
  const session = await reconnect();
  t.after(() => session.close());
  const reply = flash.reply;
  flash.reply = frame => {
    if (frame[0] === 0x25) throw new Error('serial disconnected');
    return reply(frame);
  };
  await assert.rejects(session.writeLierda(firmware, { saveBackup: assert.fail }), /serial disconnected/);
  assert.equal(files.size, 0);
  assert.deepEqual(flash.externalWritten, []);
  assert.deepEqual(flash.erased, []);
});

test('an uncommitted empty journal does not block a new update, while nonempty damage does', async t => {
  const files = originStorage(t);
  const id = 'a'.repeat(64);
  const path = 'pm-pro-' + id + '.json';
  files.set(path, new Blob([]));
  assert.equal(await pmProRecoveryStore.hasPending(), false);
  assert.equal(await pmProRecoveryStore.find(id), null);
  const record = { identity: id, version: 1, stage: 'external',
    packageSha: 'b'.repeat(64), digest: 'c'.repeat(64), name: 'lierda-pro-pm-internal-spi1-20261127155538001-00112233.bin' };
  await pmProRecoveryStore.replace(id, null, record);
  assert.equal(await pmProRecoveryStore.hasPending(), true);
  assert.deepEqual(await pmProRecoveryStore.find(id), record);
  files.set(path, new Blob(['{']));
  await assert.rejects(pmProRecoveryStore.find(id), /续刷记录无效/);
});

test('cleanup failure permits reset; a complete PM Pro is rechecked without an erase and can start a new package', async t => {
  const { files, uid, flash, external, reconnect, saveBackup, firmware } = setup(t);
  const identity = createHash('sha256').update(uid).digest('hex');
  const replace = pmProRecoveryStore.replace.bind(pmProRecoveryStore);
  let rejectVerifiedMarker = true;
  t.mock.method(pmProRecoveryStore, 'replace', async (id, before, after) => {
    if (!after || (after.stage === 'verified' && rejectVerifiedMarker)) throw new Error('Storage unavailable');
    await replace(id, before, after);
  });
  const first = await reconnect();
  const messages = [];
  const success = await first.writeLierda(firmware, { saveBackup, log: line => messages.push(line) });
  assert.deepEqual(success.verifiedImages.map(i => i.role), ['EXT', 'APP']);
  assert.ok(messages.some(line => line.includes('续刷记录清理失败')));
  await first.reset();
  await first.close();
  const original = await pmProRecoveryStore.find(identity);
  assert.equal(original.stage, 'internal');
  const counts = () => [flash.erased.length, flash.written.length, flash.externalWritten.length];
  const written = counts();

  rejectVerifiedMarker = false;
  const again = await reconnect();
  const checked = await again.writeLierda(firmware, { saveBackup: assert.fail });
  assert.deepEqual(checked, success);
  assert.deepEqual(counts(), written);
  await again.reset();
  await again.close();
  const completed = await pmProRecoveryStore.find(identity);
  assert.equal(completed.stage, 'verified');
  assert.equal(await pmProRecoveryStore.hasPending(), false);

  external[external.length - 1] ^= 1;
  const changed = await reconnect();
  await assert.rejects(changed.writeLierda(firmware, {
    saveBackup: () => { throw new Error('Fresh backup required before restoring SPI1'); },
  }), /Fresh backup required/);
  assert.deepEqual(counts(), written);
  await changed.close();

  const next = await reconnect();
  t.after(() => next.close());
  const other = Buffer.from(firmware.bytes);
  other[50] ^= 1;
  await assert.rejects(next.writeLierda({ ...firmware, bytes: other, sha256: undefined }, {
    saveBackup,
    onProgress(_, step) { if (step === '写入 SPI1 界面资源') throw new Error('Stopped before new write'); },
  }), /Stopped before new write/);
  const pending = await pmProRecoveryStore.find(identity);
  assert.equal(pending.stage, 'external');
  assert.notEqual(pending.name, original.name);
  assert.notEqual(pending.packageSha, original.packageSha);
  assert.ok(files.has(original.name));
  assert.deepEqual(counts(), written);
});
