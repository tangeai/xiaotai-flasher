const decoder = new TextDecoder();

function decodeMessage(frame) {
  const bytes = Uint8Array.from(frame);
  const fields = new DataView(bytes.buffer);
  const formatEnd = bytes.indexOf(0, 12);
  if (bytes.length < 13 || fields.getUint32(4, true) !== 0 || formatEnd < 13)
    return '';

  const format = decoder.decode(bytes.subarray(12, formatEnd));
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/u.test(format)) return '';
  const argumentsStart = (formatEnd + 4) & ~3;
  let offset = argumentsStart;
  let unresolved = false;
  const message = format.replace(
    /%(?:([-+ #0]*)(\d*)(?:\.(\d+|\*))?(hh|ll|h|l)?([a-zA-Z])|(%))/g,
    (token, flags, width, precision, modifier, type, literal) => {
      if (literal) return '%';
      if (unresolved || offset + 4 > bytes.length) return token;
      const start = offset;
      const raw = fields.getUint32(offset, true);
      offset += 4;
      if (type === 's' && !modifier) {
        const end = offset + raw;
        if (end <= bytes.length) {
          const result = decoder
            .decode(bytes.subarray(offset, end))
            .replace(/\0$/, '');
          offset = (end + 3) & ~3;
          return precision && precision !== '*'
            ? result.slice(0, Number(precision))
            : result;
        }
      } else if (precision !== '*' && 'diuxXo'.includes(type)) {
        if (modifier === 'll' && offset + 4 > bytes.length) {
          unresolved = true;
          return token;
        }
        const signed = type === 'd' || type === 'i';
        const bits =
          modifier === 'hh'
            ? 8
            : modifier === 'h'
              ? 16
              : modifier === 'll'
                ? 64
                : 32;
        const number =
          bits === 64 ? fields.getBigUint64(start, true) : BigInt(raw);
        if (bits === 64) offset += 4;
        const value = signed
          ? BigInt.asIntN(bits, number)
          : BigInt.asUintN(bits, number);
        const base = type === 'o' ? 8 : /x/i.test(type) ? 16 : 10;
        const prefix =
          value < 0n ? '-' : flags.includes('+') && signed ? '+' : '';
        const digits = (value < 0n ? -value : value).toString(base);
        const display = type === 'X' ? digits.toUpperCase() : digits;
        if (flags.includes('0') && !flags.includes('-'))
          return (
            prefix +
            display.padStart(
              Math.max(0, Math.min(256, Number(width)) - prefix.length),
              '0',
            )
          );
        return prefix + display;
      } else if (
        precision !== '*' &&
        'fFegEG'.includes(type) &&
        offset + 4 <= bytes.length
      ) {
        const value = fields.getFloat64(start, true);
        offset += 4;
        return String(value);
      } else if (precision !== '*' && type === 'p') {
        return '0x' + raw.toString(16).padStart(8, '0');
      } else if (precision !== '*' && type === 'c') {
        return String.fromCharCode(raw & 255);
      }
      unresolved = true;
      return token;
    },
  );
  const seconds = (fields.getUint32(0, true) / 1000).toFixed(3);
  return `[${seconds}s] ${message.trimEnd()}\n`;
}

export function createEc718LogDecoder() {
  let frame = null;
  let escaped = false;
  return {
    decode(chunk = []) {
      const lines = [];
      for (const byte of chunk) {
        if (byte === 0x7e) {
          if (frame && !escaped) lines.push(decodeMessage(frame));
          frame = [];
          escaped = false;
        } else if (frame && escaped) {
          frame.push(byte ^ 0x20);
          escaped = false;
        } else if (frame && byte === 0x7d) {
          escaped = true;
        } else if (frame) {
          frame.push(byte);
        }
        if (frame?.length > 8192) frame = null;
      }
      return lines.join('');
    },
  };
}
