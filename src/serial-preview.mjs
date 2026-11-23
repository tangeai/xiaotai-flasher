// Track recent line starts independently of the character limit so short lines
// cannot create an unbounded number of timestamps or highlighted DOM nodes.
export function createSerialPreview(limit, lineLimit = 1000) {
  let text = '';
  let base = 0;
  let lineCount = 0;
  const lines = [];
  let newSession = false;

  function startLine(offset, time) {
    lines[lineCount % lineLimit] = { offset, time };
    lineCount++;
  }

  return {
    beginSession() {
      newSession = true;
    },
    append(chunk, time = Date.now()) {
      if (!chunk) return;
      const offset = base + text.length;
      const last = text.at(-1);
      if (newSession && last && !/[\r\n]/.test(last) && !/^[\r\n]/.test(chunk))
        chunk = '\n' + chunk;
      newSession = false;
      if (last === undefined || last === '\n' || (last === '\r' && chunk[0] !== '\n'))
        startLine(offset, time);
      for (const newline of chunk.matchAll(/\r\n|[\r\n]/g)) {
        const next = newline.index + newline[0].length;
        if (next < chunk.length) startLine(offset + next, time);
      }
      text += chunk;
      if (text.length > limit * 2) {
        base += text.length - limit;
        text = text.slice(-limit);
      }
    },
    snapshot() {
      let firstLine = lineCount - lines.length;
      const offset = Math.max(0, base + text.length - limit, lines[firstLine % lineLimit]?.offset ?? 0);
      while (firstLine + 1 < lineCount && lines[(firstLine + 1) % lineLimit].offset <= offset)
        firstLine++;
      const stamps = [];
      for (let n = firstLine; n < lineCount; n++) {
        const line = lines[n % lineLimit];
        if (stamps.at(-1)?.time !== line.time) stamps.push(line);
      }
      return { text: text.slice(offset - base), offset, firstLine, stamps };
    },
  };
}

export function previewOffset(preview, showTime) {
  // "[HH:mm:ss.SSS] " adds 15 displayed characters per preceding line.
  return preview.offset + (showTime ? preview.firstLine * 15 : 0);
}

function localTime(time) {
  const date = new Date(time);
  const pair = value => String(value).padStart(2, '0');
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pair).join(':');
  return '[' + clock + '.' + String(date.getMilliseconds()).padStart(3, '0') + ']';
}

export function timestampedPreview({ text, offset, stamps }) {
  let index = 0;
  let stamp = '';
  return text.replace(/[^\r\n]+(?:\r\n|[\r\n])?|\r\n|[\r\n]/g, (line, position) => {
    while (index + 1 < stamps.length && stamps[index + 1].offset <= offset + position) {
      index++;
      stamp = '';
    }
    if (!stamp) stamp = localTime(stamps[index].time);
    return stamp + ' ' + line;
  });
}
