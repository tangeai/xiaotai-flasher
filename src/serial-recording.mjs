import { LocalizedError } from './i18n.mjs';
// Keep each committed file small enough to reopen for the next checkpoint.
const partBytes = 10 * 1024 * 1024;
const checkpointCharacters = 256 * 1024;
const maxBufferedCharacters = 2 * 1024 * 1024;

export function startSerialRecording(directory, onError) {
  const now = new Date();
  const stamp = String(now.getFullYear()) + [
    now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(),
  ].map(value => String(value).padStart(2, '0')).join('');
  let part = 0;
  let file;
  let size = 0;
  let pending = [];
  let characters = 0;
  let queuedCharacters = 0;
  let writing = Promise.resolve();
  let stopped = false;
  let failed = false;
  let overflowed = false;

  async function commit(blob) {
    if (!file || size + blob.size > partBytes) {
      // Serialize filename allocation across workbench tabs recording in the same second.
      file = await navigator.locks.request('serial-log-' + stamp, async () => {
        for (;;) {
          const name = stamp + '-' + String(++part).padStart(3, '0') + '.log';
          try {
            await directory.getFileHandle(name);
          } catch (error) {
            if (error.name === 'TypeMismatchError') continue;
            if (error.name !== 'NotFoundError') throw error;
            return directory.getFileHandle(name, { create: true });
          }
        }
      });
      size = 0;
    }
    const stream = await file.createWritable({ keepExistingData: size > 0 });
    try {
      if ((await file.getFile()).size !== size)
        throw new LocalizedError('日志文件大小已被更改，请重新开始记录。');
      await stream.seek(size);
      await stream.write(blob);
      await stream.close();
      size += blob.size;
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }

  function flush() {
    if (!characters) return writing;
    // Tiny UART chunks otherwise become separate browser Blob parts.
    const blob = new Blob([pending.join('')]);
    const count = characters;
    queuedCharacters += count;
    pending = [];
    characters = 0;
    writing = writing.then(async () => {
      try {
        if (!failed) await commit(blob);
      } catch (error) {
        failed = true;
        clearInterval(timer);
        onError(error);
      } finally {
        queuedCharacters -= count;
      }
    });
    return writing;
  }

  const timer = setInterval(flush, 30000);
  return {
    append(text) {
      if (stopped || failed || !text) return;
      if (queuedCharacters + characters + text.length > maxBufferedCharacters) {
        stopped = true;
        overflowed = true;
        clearInterval(timer);
        flush();
        onError(new LocalizedError('写入速度跟不上串口输出，已停止接收新日志。'));
        return;
      }
      pending.push(text);
      characters += text.length;
      if (characters >= checkpointCharacters) return flush();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await flush();
      return !failed && !overflowed;
    },
  };
}
