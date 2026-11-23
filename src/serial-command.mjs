export function encodeSerialCommand(command, format, ending) {
  if (format === 'hex') {
    const groups = command.trim().split(/\s+/);
    if (!groups.every(group => /^(?:[\da-f]{2})+$/i.test(group)))
      throw new Error('HEX 请输入完整的两位字节，例如 AA 01 FF。');
    return Uint8Array.from(groups.join('').match(/../g), pair => parseInt(pair, 16));
  }
  if (format !== 'text' || !['', '\r', '\n', '\r\n'].includes(ending))
    throw new Error('指令格式或行尾无效。');
  return new TextEncoder().encode(command + ending);
}
