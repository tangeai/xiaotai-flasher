import { chips } from './chips.mjs';
import { lierdaBoardForLink } from './lierda-boards.mjs';

export const localPlatforms = new Map([
  ['esp32', '乐鑫 Espressif（ESP32 系列）'],
  ['bk7258', '博通集成 Beken（BK7258）'],
  ['lierda', '利尔达（移芯PM HM系列）'],
]);

export function flashProtocol({ slug, chip }) {
  if (lierdaBoardForLink(slug)) return 'lierda';
  if (chip === 'BK7258') return 'bk7258';
  return chips.includes(chip) ? 'esp32' : null;
}

export function catalogPlatforms(boards) {
  return new Map(boards.map(board => [board.platform, board.platform_name]));
}

export function platformDefinitions(rows) {
  if (!Array.isArray(rows)) throw new Error('平台标识或名称无效。');
  const names = new Map();
  for (const row of rows) {
    const id = row?.platform;
    const name = row?.platform_name;
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || names.has(id) ||
        typeof name !== 'string' || !name.trim()) throw new Error('平台标识或名称无效。');
    names.set(id, name.trim());
  }
  return names;
}
