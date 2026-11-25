import { LocalizedError, t, localizedMessage } from './i18n.mjs';
import { getLierdaHardwareProfile, lierdaSha256 } from './lierda-package.mjs';

export async function persistLierdaFlashBackup(bytes, sha256, model) {
  const { size } = getLierdaHardwareProfile(model);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
    throw new LocalizedError(localizedMessage('利尔达备份需要完整的 @0 MiB Flash。', size / 0x100000));
  }
  if (!navigator.storage?.getDirectory) {
    throw new LocalizedError('此浏览器无法保存 Flash 备份，请使用支持本地文件存储的桌面 Chrome 或 Edge。');
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
      throw new LocalizedError('保存后重新读取的备份 SHA-256 不一致。');
    }
  } catch (error) {
    if (handle) await folder.removeEntry(name).catch(() => {});
    throw new LocalizedError(localizedMessage('Flash 备份保存失败。@0', error), { cause: error });
  }
  return { handle, name, location: t('浏览器本地文件 @0', name), sha256 };
}
