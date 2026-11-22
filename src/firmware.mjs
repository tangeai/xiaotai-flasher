import { ec718AgentSize, ec718PackageLimit } from './ec718-image.mjs';
import { parseAddress, validateLayout } from './flash-image.mjs';

export const chips = [
  'ESP32',
  'ESP32-S2',
  'ESP32-S3',
  'ESP32-C2',
  'ESP32-C3',
  'ESP32-C5',
  'ESP32-C6',
  'ESP32-H2',
  'ESP32-P4',
];

export function prepareFirmware(
  { origin, board, version, merged, segmented, segments, expectedChip, agent },
  capacity,
) {
  if (origin === 'official') {
    const release = board?.versions.find(
      (candidate) => candidate.version === version,
    );
    if (!release) throw new Error('请选择开发板和固件版本。');
    const packageImage = board.chip === 'EC718PM';
    if (packageImage && !release.agent_url) checkAgent(agent);
    return {
      kind: 'official',
      packageImage,
      agent: packageImage && !release.agent_url ? agent : undefined,
      release,
      chip: board.chip,
      boardModel: board.model,
      flashBytes: board.flashBytes,
    };
  }
  if (expectedChip === 'EC718PM') {
    if (
      !merged?.size ||
      merged.size > ec718PackageLimit ||
      !/\.binpkg$/i.test(merged.name)
    )
      throw new Error('请选择 Air780EPM 固件包（.binpkg）。');
    checkAgent(agent);
    return {
      kind: 'package',
      packageImage: true,
      agent,
      entries: [{ file: merged, name: merged.name, size: merged.size }],
      chip: expectedChip,
      boardModel: 'Air780EPM',
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

function checkAgent(agent) {
  if (agent?.size !== ec718AgentSize || !/\.bin$/i.test(agent.name))
    throw new Error(
      '请选择匹配的 USB AgentBoot（ec718m_usb.bin，50788 字节）。',
    );
}
