import { LocalizedError } from './i18n.mjs';
export function encodeSerialCommand(command, format, ending) {
  if (format === 'hex') {
    const groups = command.trim().split(/\s+/);
    if (!groups.every(group => /^(?:[\da-f]{2})+$/i.test(group)))
      throw new LocalizedError('HEX 请输入完整的两位字节，例如 AA 01 FF。');
    return Uint8Array.from(groups.join('').match(/../g), pair => parseInt(pair, 16));
  }
  if (format !== 'text' || !['', '\r', '\n', '\r\n'].includes(ending))
    throw new LocalizedError('指令格式或行尾无效。');
  return new TextEncoder().encode(command + ending);
}

// Ignore a line that was already underway when the probe was sent.
export function createAtReplyReader(atLineStart) {
  let line = '';
  let skip = !atLineStart;
  return chunk => {
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i < chunk.length && chunk[i] !== '\r' && chunk[i] !== '\n') continue;
      if (line.length + i - start > 256) skip = true;
      if (!skip) line += chunk.slice(start, i);
      if (i === chunk.length) break;
      if (!skip && (line === 'OK' || line === 'Unrecognized command' || /^ERROR(?::.*)?$/.test(line))) return line;
      line = '';
      skip = false;
      start = i + 1;
    }
    return null;
  };
}
