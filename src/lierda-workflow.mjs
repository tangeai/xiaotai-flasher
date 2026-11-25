import { getLierdaHardwareProfile, lierdaSha256 } from './lierda-package.mjs';

export async function persistLierdaFlashBackup(bytes, sha256, model) {
  const { size } = getLierdaHardwareProfile(model);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
    throw new Error(`利尔达备份需要完整的 ${size / 0x100000} MiB Flash。`);
  }
  if (!navigator.storage?.getDirectory) {
    throw new Error('此浏览器无法保存 Flash 备份，请使用支持本地文件存储的桌面 Chrome 或 Edge。');
  }
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('lierda-flash-backup', { create: true });
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const name = 'lierda-' + model + '-' + timestamp + '-' + crypto.randomUUID().slice(0, 8) + '.bin';
  let handle;
  try {
    handle = await folder.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(bytes);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    const saved = await handle.getFile();
    if (saved.size !== size || await lierdaSha256(await saved.arrayBuffer()) !== sha256) {
      throw new Error('保存后重新读取的备份 SHA-256 不一致。');
    }
  } catch (error) {
    if (handle) await folder.removeEntry(name).catch(() => {});
    throw new Error('Flash 备份保存失败。' + error.message, { cause: error });
  }
  return { handle, name, location: '浏览器本地文件 ' + name, sha256 };
}
