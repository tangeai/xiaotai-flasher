import { downloadFirmware } from './catalog.mjs';

import { lierdaBoards } from './lierda-boards.mjs';

export { lierdaBoards };

const packageOverhead = 0x10000;

export function prepareLierdaFirmware({ model, file, origin, selectedRelease }, capacity) {
  const board = lierdaBoards.find((candidate) => candidate.model === model);
  if (!board) throw new Error('请选择实际连接的利尔达 Lite 或 Pro 板型。');
  if (capacity != null && capacity !== board.flashBytes) {
    throw new Error('已连接设备的 Flash 容量与所选利尔达板型不匹配。');
  }

  const firmware = {
    kind: 'lierda',
    model: board.model,
    chip: board.chip,
    flashBytes: board.flashBytes,
    boardModel: board.name,
    origin,
  };

  if (origin === 'official') {
    const release = selectedRelease;
    if (!release) throw new Error(`暂无可选的在线固件，可导入本地 ${board.modempkg} BINPKG。`);
    return { ...firmware, release, filename: release.filename };
  }
  if (origin !== 'local') throw new Error('请选择固件来源。');
  if (typeof file?.arrayBuffer !== 'function') throw new Error('请选择完整的本地 BINPKG 固件。');
  if (typeof file.name !== 'string' || !/^.+\.binpkg$/i.test(file.name)) {
    throw new Error('利尔达固件文件扩展名应为 .binpkg。');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('BINPKG 固件文件为空或文件大小无效。');
  }
  if (file.size > board.flashBytes + packageOverhead) {
    throw new Error(`BINPKG 超出 ${board.name} 的固件包大小限制。`);
  }
  return { ...firmware, file, filename: file.name };
}

export async function resolveLierdaFirmware(firmware, signal) {
  if (firmware?.kind !== 'lierda') throw new Error('请选择利尔达 BINPKG 固件。');
  signal?.throwIfAborted();
  const { origin, model, filename, file, release } = prepareLierdaFirmware({
    ...firmware, selectedRelease: firmware.release,
  });
  const selection = { model, stage: 'app', filename };

  if (origin === 'official') {
    const { data, size } = await downloadFirmware(release, release.byte_length, signal);
    if (size !== release.byte_length) throw new Error('下载固件的文件大小与发布信息不一致。');
    return { ...selection, bytes: data, sha256: release.sha256 };
  }

  const expectedSize = file.size;
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  if (bytes.byteLength !== expectedSize) throw new Error('本地固件的文件大小发生变化。');
  return { ...selection, bytes };
}
