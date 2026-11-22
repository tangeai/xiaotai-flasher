import {
  ec718AgentSize,
  ec718PackageLimit,
  parseEc718Package,
  sha256,
  validateEc718Agent,
} from './ec718-image.mjs';

export const ec718Baud = 921600;
export const ec718BootPort = { usbVendorId: 0x17d1, usbProductId: 1 };
export const ec718LogPort = { usbVendorId: 0x19d1, usbProductId: 1 };
const syncWords = { rom: 0x2b02d300, agent: 0x2b02d3aa, lpc: 0x2b02d3cd };
const imageHeader = 0x54494d48;
const agentImage = 0x4f424d49;
const empty = new Uint8Array();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const view = (data) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);
const uint32 = (value) => {
  const bytes = new Uint8Array(4);
  view(bytes).setUint32(0, value, true);
  return bytes;
};

export function requireEc718Port(port, expected, message) {
  const info = port.getInfo();
  if (
    info.usbVendorId !== expected.usbVendorId ||
    info.usbProductId !== expected.usbProductId
  )
    throw new Error(message);
}

function crc8(data) {
  let result = 0;
  for (const byte of data) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      result = (result >>> 1) ^ (result & 1 ? 0x8c : 0);
  }
  return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let result = index;
  for (let bit = 0; bit < 8; bit += 1)
    result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  return result;
});

function crc32(data) {
  let result = 0xffffffff;
  for (const byte of data)
    result = (result >>> 8) ^ crcTable[(result ^ byte) & 255];
  return (result ^ 0xffffffff) >>> 0;
}

class SerialTimeout extends Error {}

// A pending Web Serial read survives a sync timeout and is reused by the next attempt.
function packetReader(reader) {
  let buffer = empty;
  let pending;
  async function read(length, deadline) {
    while (buffer.length < length) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new SerialTimeout('等待 EC718 串口响应超时。');
      pending ??= reader.read();
      let timer;
      const next = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new SerialTimeout('等待 EC718 串口响应超时。')),
            remaining,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      pending = null;
      if (next.done) throw new Error('EC718 下载串口已断开。');
      const combined = new Uint8Array(buffer.length + next.value.length);
      combined.set(buffer);
      combined.set(next.value, buffer.length);
      buffer = combined;
    }
    const output = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return output;
  }

  return {
    read,
    discard: () => {
      buffer = empty;
    },
  };
}

// Protocol reference: https://github.com/wendal/luatos-cli/blob/main/docs/ec718-flash-protocol.md
export function createEc718Protocol(reader, writer) {
  const input = packetReader(reader);

  async function sync(mode) {
    const word = uint32(syncWords[mode]);
    const response = mode === 'rom' ? new Uint8Array([...word, 0]) : word;
    input.discard();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await writer.write(word);
      const deadline = performance.now() + 350;
      let matched = 0;
      try {
        while (matched < response.length) {
          const [byte] = await input.read(1, deadline);
          matched =
            byte === response[matched]
              ? matched + 1
              : Number(byte === response[0]);
        }
        input.discard();
        return;
      } catch (error) {
        if (!(error instanceof SerialTimeout)) throw error;
      }
    }
    throw new Error(
      `EC718 ${mode.toUpperCase()} 握手超时。请确认设备仍处于下载模式。`,
    );
  }

  async function command(mode, id, data = empty, index = 0) {
    const rom = mode === 'rom';
    const trailer = !rom || id === 0x32 ? 4 : 0;
    const plainLength = 8 + data.length;
    const frame = new Uint8Array(plainLength + trailer);
    frame.set([id, index, ...(mode === 'lpc' ? [0x4c, 0xb3] : [0xcd, 0x32])]);
    view(frame).setUint32(4, data.length, true);
    frame.set(data, 8);
    if (trailer) {
      const body = frame.subarray(0, plainLength);
      const checksum = rom
        ? body.reduce((sum, byte) => sum + byte, 0)
        : crc32(body);
      view(frame).setUint32(plainLength, checksum, true);
    }
    if (!rom) frame[7] = crc8(frame.subarray(4, 7));

    await writer.write(frame);
    const deadline = performance.now() + (id === 0x44 ? 10000 : 2200);
    const header = await input.read(6, deadline);
    const tail = await input.read(header[5] + (rom ? 0 : 4), deadline);
    if (
      header[0] !== id ||
      header[1] !== index ||
      (header[2] ^ header[3]) !== 255 ||
      header[4] !== 0
    )
      throw new Error(
        `EC718 命令 0x${id.toString(16)} 返回无效响应（状态 ${header[4]}）。`,
      );
    return tail.subarray(0, header[5]);
  }

  async function selectImage(mode, identifier) {
    await command(mode, 0x20);
    const selected = await command(mode, 0x21);
    if (selected.length < 4 || view(selected).getUint32(0, true) !== identifier)
      throw new Error('EC718 返回的镜像类型与当前写入步骤不一致。');
    await command(mode, 0x22);
  }

  async function transfer(mode, data) {
    for (let offset = 0, index = 0; offset < data.length; index += 1) {
      const remaining = data.length - offset;
      const reply = await command(mode, 0x31, uint32(remaining));
      const size = reply.length >= 4 ? view(reply).getUint32(0, true) : 0;
      if (!size) throw new Error('EC718 下载端返回了无效的传输长度。');
      const end = offset + Math.min(size, remaining);
      await command(mode, 0x32, data.subarray(offset, end), index & 255);
      offset = end;
    }
    await command(mode, 0x3a);
  }

  async function sendHeader(mode, identifier, address, size, digest) {
    const header = new Uint8Array(272);
    const fields = view(header);
    fields.setUint32(0, 0x10000001, true);
    fields.setUint32(4, imageHeader, true);
    fields.setUint32(8, 0x20180507, true);
    fields.setUint32(16, 1, true);
    header[20] = 0xee;
    if (mode === 'rom') {
      fields.setUint16(22, 0x8000 + Math.floor(ec718Baud / 100), true);
      fields.setUint32(24, 1, true);
    }
    fields.setUint32(64, identifier, true);
    fields.setUint32(68, address, true);
    fields.setUint32(72, 0x04010000, true);
    fields.setUint32(76, size, true);
    header.set(digest, 96);
    header.set(await sha256(header), 32);
    await transfer(mode, header);
  }

  return {
    sync,
    async loadAgent(agent) {
      const digest = await sha256(agent);
      await selectImage('rom', imageHeader);
      await sendHeader('rom', agentImage, 0, agent.length, digest);
      await sync('rom');
      await selectImage('rom', agentImage);
      await transfer('rom', agent);
    },
    async burn(partition, onBytes) {
      const { identifier, address, data, digest } = partition;
      await sync('lpc');
      await command('lpc', 0x42, uint32(identifier));
      await sync('agent');
      await sync('agent');
      await selectImage('agent', imageHeader);
      await sendHeader('agent', identifier, address, data.length, digest);
      for (let offset = 0; offset < data.length; offset += 0x10000) {
        const block = data.subarray(offset, offset + 0x10000);
        await sync('agent');
        await selectImage('agent', identifier);
        await transfer('agent', block);
        onBytes(block.length);
      }
      const result = await command('lpc', 0x44);
      if (result.length !== 4 || view(result).getUint32(0, true) !== 0)
        throw new Error(`EC718 ${partition.type} 分区写入校验失败。`);
    },
    async reset() {
      await sync('lpc');
      const reply = await command('lpc', 0xaa);
      if (new TextDecoder().decode(reply) !== 'ZzZzZzZz') {
        throw new Error('未收到 EC718 复位确认，请检查设备是否已启动。');
      }
    },
  };
}

export async function connectEc718(port, _options, log) {
  requireEc718Port(
    port,
    ec718BootPort,
    '请选择 Air780EPM 的 USB BOOT 下载串口。',
  );
  await port.open({ baudRate: ec718Baud, bufferSize: 65536 });
  let reader;
  let writer;
  let closing;
  function close() {
    closing ??= (async () => {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      writer?.releaseLock();
      if (port.readable || port.writable) await port.close();
    })();
    return closing;
  }
  try {
    await port.setSignals({ dataTerminalReady: true });
    await pause(80);
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const protocol = createEc718Protocol(reader, writer);
    await protocol.sync('rom');
    log('Air780EPM USB BOOT 已握手。\n');
    return {
      chip: 'EC718PM',
      capacity: 0x400000,
      capacityLabel: '4 MiB（Air780EPM）',
      downloadLimit: ec718PackageLimit,
      separateLogPort: true,
      close,
      reset: protocol.reset,
      async write(images, { agent }, onProgress) {
        if (images.length !== 1 || !agent || agent.length !== ec718AgentSize)
          throw new Error('请选择 Air780EPM 固件包和匹配的 USB AgentBoot。');
        const [image] = images;
        const partitions = await parseEc718Package(image.data);
        await validateEc718Agent(agent);
        log('固件包及 AgentBoot 校验通过，正在将 AgentBoot 加载到 RAM。\n');
        await protocol.loadAgent(agent);
        const total = partitions.reduce(
          (sum, entry) => sum + entry.data.length,
          0,
        );
        let written = 0;
        for (const partition of partitions) {
          log(`正在写入 ${partition.type} 分区。\n`);
          await protocol.burn(partition, (size) => {
            written += size;
            onProgress(0.1 + 0.9 * (written / total));
          });
          log(`${partition.type} 分区写入校验通过。\n`);
        }
      },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
