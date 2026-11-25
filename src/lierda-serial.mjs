// Host-side protocol adapted from yuzhan-tech/ectool v0.1.0 (MIT).
// d8b472126a9a070439df6b3c5677071a01b0c026
// https://github.com/yuzhan-tech/ectool/tree/d8b472126a9a070439df6b3c5677071a01b0c026
// See public/vendor/ectool-LICENSE.txt for the upstream notice.

const DOWNLOAD_VENDOR = 0x17d1;
const DOWNLOAD_PRODUCT = 0x0001;
const AGENT_BYTE_LENGTH = 50_032;
const AGENT_DIGEST = "045bd0c74a030143230f07484e4711600005b992e3b0776be042e42d141a38e5";
const USB_BAUD = 921_600;
const EC718PM_ROM_PREFIX = "0000030301000000";

const ROM_SYNC = 0x2b02d300;
const LPC_SYNC = 0x2b02d3cd;
const AGENT_SYNC = 0x2b02d3aa;
const HEAD_IMAGE = 0x54494d48;
const AGENT_IMAGE = 0x4f424d49;
const ROM_COMMANDS = {
  version: 0x20,
  selectImage: 0x21,
  verifyImage: 0x22,
  dataHead: 0x31,
  downloadData: 0x32,
  done: 0x3a,
};
const LPC_READ_MEM = 0x21;
const SERIAL_TIMEOUT_MS = 800;
const WRITE_TIMEOUT_MS = 3_000;
const SYNC_ATTEMPTS = 5;
const MAX_ROM_DATA_CHUNK = 0x10000;
const MAX_ROM_RESPONSE = 12;
const RESPONSE_HEADER_LENGTH = 6;
const EMPTY = new Uint8Array(0);

class SerialTimeout extends Error {}
class AtPortClosed extends Error {}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(task, ms, detail) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SerialTimeout(detail)), Math.max(0, ms));
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const AT_VENDOR = 0x3505;
const AT_PRODUCT = 0x0003;
const AT_BAUD = 115_200;
const AT_REPLY_LIMIT = 4096;
const AT_DRAIN_MS = 80;
const AT_REPLY_MS = 1600;
const QDLOADER_WAIT_MS = 8_000;
const QDLOADER_POLL_MS = 80;
const atProbe = new TextEncoder().encode('AT\r\n');
const atIdentity = new TextEncoder().encode('ATI\r\n');
const atDownload = new TextEncoder().encode('AT+ECRST=delay,599\r\n');

// The Lierda Windows AT interface PDO exposes VID_3505 but can omit the PID.
// The chooser label and an actual AT response identify the function of the port.
export const lierdaAtFilter = Object.freeze({ usbVendorId: AT_VENDOR });
export const lierdaDownloadFilter = Object.freeze({
  usbVendorId: DOWNLOAD_VENDOR,
  usbProductId: DOWNLOAD_PRODUCT,
});

export function isLierdaAtPort(port) {
  const info = port?.getInfo?.();
  return info?.usbVendorId === AT_VENDOR &&
    (info.usbProductId === undefined || info.usbProductId === AT_PRODUCT);
}

export function isDownloadPort(port) {
  const info = port?.getInfo?.();
  return info?.usbVendorId === DOWNLOAD_VENDOR && info.usbProductId === DOWNLOAD_PRODUCT;
}

export async function selectLierdaPort(serial, { downloadOnly = false, chooseOther = false } = {}) {
  if (!chooseOther) {
    const getPermitted = async () => (await serial.getPorts()).filter((port) =>
      port.connected !== false && (isDownloadPort(port) || (!downloadOnly && isLierdaAtPort(port))),
    );
    let permitted = await getPermitted();
    if (permitted.length === 0 && !downloadOnly) {
      // Let Windows finish publishing an already authorized USB interface.
      await wait(200);
      permitted = await getPermitted();
    }
    if (permitted.length === 1) return permitted[0];
    if (!downloadOnly && permitted.length > 1 && permitted.length <= 3 && permitted.every(isLierdaAtPort)) {
      // Windows may expose the same VID and omit the PID for the AT, log
      // and UART interfaces. Probe only ports this page can already access.
      const results = await Promise.allSettled(permitted.map(identifyLierdaAtPort));
      const matches = permitted.filter((_, i) => results[i].status === 'fulfilled' && results[i].value);
      if (matches.length === 1 && results.every(result => result.status === 'fulfilled')) {
        return matches[0];
      }
    }
  }
  if (globalThis.navigator?.userActivation?.isActive === false) {
    throw new Error('无法自动确认串口，请点击「选择其他串口」。');
  }
  if (downloadOnly) return serial.requestPort({ filters: [lierdaDownloadFilter] });
  return serial.requestPort();
}

function newDownloadPorts(ports, previous) {
  return ports.filter((port) => port.connected !== false && isDownloadPort(port) && !previous.has(port));
}

function previousDownloadPortsStillConnected(previous, ports) {
  // A reconnected device can receive a new SerialPort object. Its arrival
  // cannot be attributed to the AT reboot if another loader disappeared.
  return [...previous].every(port => port.connected !== false && ports.includes(port));
}

function atPortDisconnected(atPort, ports) {
  if (!atPort) return true;
  return typeof atPort.connected === 'boolean' ? !atPort.connected : !ports.includes(atPort);
}

export async function selectLierdaDownloadPort(serial, { atPort, previousPorts }) {
  const previous = new Set(previousPorts.filter(isDownloadPort));
  const ports = await serial.getPorts();
  const candidates = newDownloadPorts(ports, previous);
  if (candidates.length === 1 && atPortDisconnected(atPort, ports)
      && previousDownloadPortsStillConnected(previous, ports)) return candidates[0];

  const selected = await serial.requestPort({ filters: [lierdaDownloadFilter] });
  if (!isDownloadPort(selected) || selected.connected === false) {
    throw new Error('请选择已连接的 Lierda QDLoader 下载口。');
  }
  if (previous.has(selected)) throw new Error('该下载口在切换前已连接。请选择刚进入下载模式的设备。');
  if (!atPortDisconnected(atPort, await serial.getPorts())) {
    throw new Error('原 AT 串口尚未断开，请等待设备进入下载模式。');
  }
  return selected;
}

function atReplies(reader, signal) {
  const decoder = new TextDecoder();
  let pending;
  let text = '';

  async function readChunk(deadline) {
    signal?.throwIfAborted();
    pending ??= reader.read();
    // Reuse a read after a timeout, including when it completes while the
    // subsequent AT write is pending. Otherwise its reply would be lost.
    const result = await withTimeout(pending, deadline - performance.now(), '等待 AT 应答超时。');
    pending = undefined;
    signal?.throwIfAborted();
    if (result.done) throw new AtPortClosed('AT 串口已断开。');
    return result.value;
  }

  return {
    async discardPending() {
      const deadline = performance.now() + AT_DRAIN_MS;
      try {
        while (performance.now() < deadline) await readChunk(deadline);
      } catch (error) {
        if (!(error instanceof SerialTimeout)) throw error;
      }
    },
    async readResult(timeoutMs, onLine) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        text += decoder.decode(await readChunk(deadline), { stream: true });
        let end;
        while ((end = text.indexOf('\n')) !== -1) {
          const line = text.slice(0, end).replace(/\r$/u, '');
          text = text.slice(end + 1);
          if (line === 'OK') return true;
          if (line === 'ERROR' || /^\+(?:CME|CMS) ERROR:/u.test(line)) return false;
          onLine?.(line.trim());
        }
        if (text.length > AT_REPLY_LIMIT) throw new Error('当前串口未返回有效的 AT 应答。');
      }
      throw new SerialTimeout('等待 AT 应答超时。');
    },
    clear() { text = ''; },
  };
}

async function withLierdaAtPort(port, signal, usePort) {
  if (!isLierdaAtPort(port)) throw new Error('请选择设备的 Lierda At Port。');
  if (port.readable || port.writable) throw new Error('请先关闭占用 AT 串口的日志或串口工具。');
  signal?.throwIfAborted();
  let reader;
  let writer;
  let opened = false;
  try {
    const opening = port.open({ baudRate: AT_BAUD, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'none' });
    try {
      await withTimeout(opening, WRITE_TIMEOUT_MS, '打开 AT 串口超时。');
      opened = true;
    } catch (error) {
      // Release even if an OS-level open completes after our deadline.
      if (error instanceof SerialTimeout) opening.then(() => port.close()).catch(() => {});
      throw error;
    }
    signal?.throwIfAborted();
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const replies = atReplies(reader, signal);
    await replies.discardPending();
    signal?.throwIfAborted();
    return await usePort(writer, replies);
  } finally {
    writer?.releaseLock();
    if (reader) {
      try {
        await withTimeout(reader.cancel(), SERIAL_TIMEOUT_MS, '关闭 AT 读取流超时。');
      } catch {
        // A device reset can already have errored the stream.
      } finally {
        reader.releaseLock();
      }
    }
    if (opened && (port.readable || port.writable)) {
      try {
        await withTimeout(port.close(), SERIAL_TIMEOUT_MS, '关闭 AT 串口超时。');
      } catch (error) {
        if (port.connected !== false && (port.readable || port.writable)) throw error;
      }
    }
  }
}

async function identifyLierdaAtPort(port) {
  return withLierdaAtPort(port, undefined, async (writer, replies) => {
    let vendor = false;
    let model = false;
    await withTimeout(writer.write(atIdentity), WRITE_TIMEOUT_MS, '发送 ATI 校验命令超时。');
    try {
      const acknowledged = await replies.readResult(AT_REPLY_MS, (line) => {
        if (line === 'Lierda') vendor = true;
        if (line === 'NT26F6D0' || line === 'NT26F9D0') model = true;
      });
      return acknowledged && vendor && model;
    } catch (error) {
      if (!(error instanceof SerialTimeout)) throw error;
      return false;
    }
  });
}

/** Verify the Lierda AT interface, then send the download reboot once. */
export async function requestLierdaDownloadMode(port, { signal, log = () => {}, timeoutMs = AT_REPLY_MS } = {}) {
  return withLierdaAtPort(port, signal, async (writer, replies) => {
    await withTimeout(writer.write(atProbe), WRITE_TIMEOUT_MS, '发送 AT 校验命令超时。');
    if (!await replies.readResult(timeoutMs)) throw new Error('AT 校验失败，请选择 Lierda At Port。');
    log('AT 串口校验通过。');
    replies.clear();
    signal?.throwIfAborted();
    await withTimeout(writer.write(atDownload), WRITE_TIMEOUT_MS, '发出下载复位命令未得到确认。');
    log('已发送一次下载复位命令，等待 QDLoader。');

    let acknowledged;
    try {
      acknowledged = await replies.readResult(timeoutMs);
    } catch (error) {
      signal?.throwIfAborted();
      // Some firmware versions disconnect USB before the reset reply arrives.
      if (!(error instanceof SerialTimeout || error instanceof AtPortClosed)
          && port.connected !== false && port.readable && error.name !== 'NetworkError') throw error;
      return { acknowledged: false };
    }
    if (!acknowledged) throw new Error('设备拒绝进入下载模式。');
    return { acknowledged: true };
  });
}

/** Wait for a new, already permitted QDLoader port. The chooser stays in the UI. */
export async function waitForLierdaDownloadPort(serial, {
  previousPorts = [], atPort, signal, timeoutMs = QDLOADER_WAIT_MS,
} = {}) {
  const previous = new Set(previousPorts.filter(isDownloadPort));
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    let ports;
    try {
      ports = await withTimeout(serial.getPorts(), deadline - performance.now(), '等待 QDLoader 超时。');
    } catch (error) {
      if (error instanceof SerialTimeout) break;
      throw error;
    }
    signal?.throwIfAborted();
    if (!previousDownloadPortsStillConnected(previous, ports)) return null;
    const candidates = newDownloadPorts(ports, previous);
    if (candidates.length > 1) throw new Error('检测到多个 QDLoader，请只连接要烧录的设备。');
    if (atPortDisconnected(atPort, ports) && candidates.length === 1) return candidates[0];
    await wait(Math.min(QDLOADER_POLL_MS, Math.max(0, deadline - performance.now())));
  }
  signal?.throwIfAborted();
  return null;
}

function bytesHex(bytes, separator = "") {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(separator);
}

function putWord(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function wordAt(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function words(...values) {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, index) => putWord(bytes, index * 4, value));
  return bytes;
}

function crc8Maxim(bytes) {
  let crc = 0;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x8c : 0);
    }
  }
  return crc;
}

function crc32(bytes, ...chunks) {
  let crc = 0xffffffff;
  for (const chunk of [bytes, ...chunks]) {
    for (const byte of chunk) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function serialIO(reader, writer) {
  let buffered = EMPTY;
  let pendingRead;

  return {
    discardBufferedInput() {
      buffered = EMPTY;
    },

    async write(bytes) {
      await withTimeout(writer.write(bytes), WRITE_TIMEOUT_MS, "Web Serial 发送超时");
    },

    async readExactly(length) {
      const deadline = performance.now() + SERIAL_TIMEOUT_MS;
      while (buffered.length < length) {
        // Keep the same pending read if only the deadline expires. An abandoned
        // read would consume the next response ahead of a new read request.
        pendingRead ??= reader.read();
        const { value, done } = await withTimeout(
          pendingRead,
          deadline - performance.now(),
          "Web Serial 接收超时"
        );
        pendingRead = undefined;
        if (done) {
          throw new Error("Web Serial 下载口已断开");
        }
        const combined = new Uint8Array(buffered.length + value.length);
        combined.set(buffered);
        combined.set(value, buffered.length);
        buffered = combined;
      }
      const result = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return result;
    },
  };
}

async function synchronize(io, word, label) {
  const token = words(word);
  let lastReply = "未收到完整回包";
  for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
    io.discardBufferedInput();
    await io.write(token);
    await wait(2);
    await io.write(token);
    await wait(2);
    let reply;
    try {
      reply = await io.readExactly(token.length);
    } catch (error) {
      if (error instanceof SerialTimeout) {
        lastReply = error.message;
        continue;
      }
      throw error;
    }
    lastReply = bytesHex(reply, " ");
    if (wordAt(reply) !== word) {
      continue;
    }

    if (word === ROM_SYNC) {
      try {
        const extra = await io.readExactly(1);
        lastReply += " " + bytesHex(extra);
        if (extra[0] !== 0) {
          continue;
        }
      } catch (error) {
        // EigenComm DLBOOT optionally returns a zero status byte after the echo.
        if (!(error instanceof SerialTimeout)) {
          throw error;
        }
      }
    }

    io.discardBufferedInput();
    return lastReply;
  }
  throw new Error(label + " 同步失败，最后一次接收 " + lastReply);
}

async function sendCommand(io, command, payload, { index = 0, lpc = false, agent = false } = {}) {
  const order = lpc ? 0x4c : 0xcd;
  const inverse = lpc ? 0xb3 : 0x32;
  const downloadData = !lpc && command === ROM_COMMANDS.downloadData;
  const usesCrc = lpc || agent;
  const plainLength = 8 + payload.length;
  const frame = new Uint8Array(plainLength + ((usesCrc || downloadData) ? 4 : 0));
  frame.set([command, index, order, inverse]);
  putWord(frame, 4, payload.length);
  frame.set(payload, 8);

  if (usesCrc) {
    // The CRC32 covers a plain length, before its high wire byte is replaced.
    putWord(frame, plainLength, crc32(frame.subarray(0, plainLength)));
    frame[7] = crc8Maxim(frame.subarray(4, 7));
  } else if (downloadData) {
    let sum = 0;
    for (let offset = 0; offset < plainLength; offset += 1) {
      sum += frame[offset];
    }
    putWord(frame, plainLength, sum);
  }

  // Browser Web Serial does not expose a native per-transaction purge.
  // Discard already buffered input, and fail on an ambiguous command reply.
  io.discardBufferedInput();
  const label = (lpc ? "LPC" : agent ? "AGBOOT" : "DLBOOT") + " 命令 0x" + command.toString(16).padStart(2, "0");
  try {
    await io.write(frame);
    if (!lpc) {
      await wait(2);
    }
    const response = await io.readExactly(RESPONSE_HEADER_LENGTH);
    const responseLength = response[5];
    if (!lpc && responseLength > MAX_ROM_RESPONSE) {
      throw new Error("回包过长，收到 " + responseLength + " 字节");
    }
    const data = responseLength > 0 ? await io.readExactly(responseLength) : EMPTY;
    if (usesCrc) {
      const checksum = await io.readExactly(4);
      if (wordAt(checksum) !== crc32(response, data)) {
        throw new Error("回包 CRC32 校验失败");
      }
    }
    const responseIndex = downloadData ? (index + 1) & 0xff : index;
    if (response[0] !== command || response[1] !== responseIndex
        || response[2] !== order || response[3] !== inverse) {
      throw new Error("回包头与请求不匹配，收到 " + bytesHex(response, " "));
    }
    if (response[4] !== 0) {
      throw new Error("设备返回错误状态 0x" + response[4].toString(16).padStart(2, "0")
        + (data.length ? " · " + bytesHex(data, " ") : ""));
    }
    return data;
  } catch (error) {
    throw new Error(label + " · " + error.message, { cause: error });
  }
}

async function imageInfo(io, imageId, label, log, agent = false) {
  const options = { agent };
  const version = await sendCommand(io, ROM_COMMANDS.version, EMPTY, options);
  if (!agent) {
    if (!bytesHex(version).startsWith(EC718PM_ROM_PREFIX)) {
      throw new Error("下载口 ROM 与已验证的利尔达移芯版本不匹配 · " + bytesHex(version, " "));
    }
    log("DLBOOT " + label + " · ROM 版本 " + bytesHex(version, " "));
  }
  const selected = await sendCommand(io, ROM_COMMANDS.selectImage, EMPTY, options);
  if (selected.length !== 4 || wordAt(selected) !== imageId) {
    throw new Error(label + " 镜像标识不匹配，收到 " + bytesHex(selected, " "));
  }
  await sendCommand(io, ROM_COMMANDS.verifyImage, EMPTY, options);
}

async function sendImageData(io, data, agent = false) {
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    const sizeResponse = await sendCommand(io, ROM_COMMANDS.dataHead, words(remaining), { agent });
    if (sizeResponse.length !== 4) {
      throw new Error("DATA_HEAD 没有返回 4 字节的传输大小");
    }
    const size = wordAt(sizeResponse);
    if (size === 0 || size > remaining || size > MAX_ROM_DATA_CHUNK) {
      throw new Error("DATA_HEAD 返回无效传输大小 " + size);
    }
    await sendCommand(io, ROM_COMMANDS.downloadData, data.subarray(offset, offset + size), { index, agent });
    offset += size;
    index = (index + 1) & 0xff;
  }
  await sendCommand(io, ROM_COMMANDS.done, EMPTY, { agent });
}

async function imageHeader(length, digest, { id, address, baud, controls }) {
  const header = new Uint8Array(272);
  putWord(header, 0, 0x10000001);       // Header version.
  putWord(header, 4, HEAD_IMAGE);
  putWord(header, 8, 0x20180507);       // Header format date.
  putWord(header, 16, 1);               // One image.
  header[20] = 0xee;                    // SHA-256 hash type.
  new DataView(header.buffer).setUint16(22, baud ? 0x8000 + baud / 100 : 0, true);
  putWord(header, 24, controls);
  putWord(header, 64, id);
  putWord(header, 68, address);
  putWord(header, 72, 0x04010000);      // Default image header load address.
  putWord(header, 76, length);
  header.set(digest, 96);
  const headerDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", header));
  header.set(headerDigest, 32);
  return header;
}

// The caller opens the QDLoader port at USB_BAUD and asserts DTR first.
async function connectAgent(port, agentBytes, log) {
  const info = port.getInfo();
  if (info.usbVendorId !== DOWNLOAD_VENDOR || info.usbProductId !== DOWNLOAD_PRODUCT) {
    throw new Error("请选择 USB 下载口 17D1:0001");
  }
  if (!(agentBytes instanceof Uint8Array) || agentBytes.length !== AGENT_BYTE_LENGTH) {
    throw new Error("AgentBoot 文件长度不匹配，应为 " + AGENT_BYTE_LENGTH + " 字节");
  }
  // The hash applies to the same snapshot sent to the chip.
  const agent = new Uint8Array(agentBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", agent));
  if (bytesHex(digest) !== AGENT_DIGEST) {
    throw new Error("AgentBoot SHA-256 与已验证的 USB 镜像不一致");
  }
  const header = await imageHeader(agent.length, digest, {
    id: AGENT_IMAGE, address: 0, baud: USB_BAUD, controls: 1,
  });
  if (!port.readable || !port.writable) throw new Error("未打开 QDLoader 串口");
  const reader = port.readable.getReader();
  let writer;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (writer) writer.releaseLock();
    try {
      await withTimeout(reader.cancel(), SERIAL_TIMEOUT_MS, "关闭 Web Serial 读取流超时");
    } catch {
      // A physical disconnect can already have errored the read stream.
    } finally {
      reader.releaseLock();
    }
  };
  try {
    writer = port.writable.getWriter();
    const io = serialIO(reader, writer);
    const reply = await synchronize(io, ROM_SYNC, "DLBOOT");
    log("DLBOOT 同步通过 · RX " + reply.toUpperCase());
    await imageInfo(io, HEAD_IMAGE, "HEAD", log);
    await sendImageData(io, header);
    await synchronize(io, ROM_SYNC, "DLBOOT 镜像头后");
    await imageInfo(io, AGENT_IMAGE, "AgentBoot", log);
    await sendImageData(io, agent);
    await synchronize(io, LPC_SYNC, "LPC");
    log("USB AgentBoot 已载入 RAM，LPC 就绪。");
    return { io, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function readMemory(io, address, length) {
  const data = await sendCommand(io, LPC_READ_MEM, words(length, address), { lpc: true });
  if (data.length !== length) {
    throw new Error("LPC 回读长度不符，应为 " + length + "，收到 " + data.length);
  }
  return data;
}

export { DOWNLOAD_VENDOR, DOWNLOAD_PRODUCT, USB_BAUD, AGENT_SYNC, LPC_SYNC, HEAD_IMAGE,
  EMPTY, words, sendCommand, synchronize, imageInfo, sendImageData, imageHeader,
  connectAgent, readMemory };
