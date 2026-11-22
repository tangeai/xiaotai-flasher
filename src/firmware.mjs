import { parseAddress, validateLayout } from './flash-image.mjs';

export function prepareFirmware(
  { origin, board, version, merged, segmented, segments, expectedChip },
  capacity,
) {
  if (origin === 'official') {
    const release = board?.versions.find(
      (candidate) => candidate.version === version,
    );
    if (!release) throw new Error('请选择开发板和固件版本。');
    return {
      kind: 'official',
      release,
      chip: board.chip,
      boardModel: board.model,
      flashBytes: board.flashBytes,
    };
  }
  const kind = segmented ? 'segments' : 'complete';
  const source = segmented
    ? segments.map(({ file, offset }) => ({
        file,
        address: parseAddress(offset),
      }))
    : [{ file: merged, address: 0 }];
  if (
    !source.length ||
    source.some(({ file }) => !file?.size || !/\.bin$/i.test(file.name))
  ) {
    throw new Error(
      segmented ? '请为每一行选择 BIN 文件。' : '请选择完整 BIN 镜像。',
    );
  }
  if (source.some(({ address }) => !Number.isInteger(address)))
    throw new Error('请填写有效的 Flash 起始地址。');
  const entries = source.map(({ file, address }) => ({
    file,
    address,
    name: file.name,
    size: file.size,
  }));
  validateLayout(entries, capacity ?? 0x100000000);
  return {
    kind,
    entries,
    chip: expectedChip,
  };
}
