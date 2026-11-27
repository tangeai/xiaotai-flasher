import { LocalizedError, t } from './i18n.mjs';
import { lierdaSha256 } from './lierda-package.mjs';
import { LPC_SYNC, sendCommand, synchronize } from './lierda-serial.mjs';

const digestPattern = /^[0-9a-f]{64}$/u;
const backupNamePattern = /^lierda-pro-pm-internal-spi1-\d{17}-[0-9a-f]{8}\.bin$/u;
const recordError = () => new LocalizedError('PM Pro 本地续刷记录无效，请保留原始备份。');

export async function readLierdaFlashIdentity(io) {
  await synchronize(io, LPC_SYNC, 'LPC');
  // Factory flash_uuid_rd selects the internal NOR (storage IE 01 E0).
  const uid = await sendCommand(io, 0x25, Uint8Array.of(1, 0xe0), { lpc: true });
  // Short or erased responses cannot bind an interrupted write to an individual NOR.
  // The factory response is variable-length; serial numbers need not appear random.
  if (uid.length < 8 || uid.every(byte => byte === 0) || uid.every(byte => byte === 0xff)) return null;
  return lierdaSha256(uid);
}

function validRecord(record, identity) {
  return record?.version === 1 && record.identity === identity && digestPattern.test(identity)
    && ['external', 'internal', 'verified'].includes(record.stage)
    && (record.fsDigest === undefined || (record.stage !== 'external'
      && typeof record.fsDigest === 'string' && digestPattern.test(record.fsDigest)))
    && digestPattern.test(record.packageSha) && digestPattern.test(record.digest)
    && backupNamePattern.test(record.name);
}

function sameRecord(a, b) {
  if (!a || !b) return a === b;
  return a.identity === b.identity && a.packageSha === b.packageSha && a.digest === b.digest
    && a.name === b.name && a.stage === b.stage && a.fsDigest === b.fsDigest;
}

async function directory() {
  if (!navigator.storage?.getDirectory) throw new LocalizedError('当前浏览器无法保存 PM Pro 续刷记录。');
  return (await navigator.storage.getDirectory()).getDirectoryHandle('lierda-flash-backup', { create: true });
}

async function readRecord(folder, identity) {
  if (!digestPattern.test(identity)) throw recordError();
  let file;
  try {
    const handle = await folder.getFileHandle('pm-pro-' + identity + '.json');
    file = await handle.getFile();
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
  // OPFS creates an empty entry before the first atomic writable is committed.
  // No flash write is issued until this first record has been read back.
  if (file.size === 0) return null;
  if (file.size > 2048) throw recordError();
  let record;
  try {
    record = JSON.parse(await file.text());
  } catch {
    throw recordError();
  }
  if (!validRecord(record, identity)) throw recordError();
  return record;
}

export const pmProRecoveryStore = {
  async find(identity) {
    return readRecord(await directory(), identity);
  },
  async hasPending() {
    const folder = await directory();
    for await (const [name] of folder.entries()) {
      const id = /^pm-pro-([0-9a-f]{64})\.json$/u.exec(name)?.[1];
      if (!id) continue;
      try {
        const record = await readRecord(folder, id);
        if (record && record.stage !== 'verified') return true;
      } catch {
        // An unreadable journal cannot be ruled out for a NOR without a UID.
        return true;
      }
    }
    return false;
  },
  async load(record) {
    if (!validRecord(record, record?.identity)) throw recordError();
    const folder = await directory();
    const handle = await folder.getFileHandle(record.name);
    const file = await handle.getFile();
    if (file.size !== 0x800000) throw recordError();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (await lierdaSha256(bytes) !== record.digest) throw recordError();
    return { bytes, digest: record.digest, packageSha: record.packageSha, name: record.name, handle,
      location: t('浏览器本地文件 @0', record.name) };
  },
  async replace(identity, previous, next) {
    const folder = await directory();
    if (!sameRecord(await readRecord(folder, identity), previous)) throw recordError();
    const filename = 'pm-pro-' + identity + '.json';
    if (!next) {
      await folder.removeEntry(filename);
      return;
    }
    if (!validRecord(next, identity)) throw recordError();
    const handle = await folder.getFileHandle(filename, { create: true });
    let writer;
    try {
      writer = await handle.createWritable();
      await writer.write(JSON.stringify(next));
      await writer.close();
    } catch (error) {
      if (writer) await writer.abort().catch(() => {});
      // An interrupted first create may have left an empty directory entry.
      if (!previous && (await handle.getFile()).size === 0) await folder.removeEntry(filename).catch(() => {});
      throw error;
    }
    if (!sameRecord(await readRecord(folder, identity), next)) throw recordError();
  },
};
