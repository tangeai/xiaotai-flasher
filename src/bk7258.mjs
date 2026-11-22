import { validateBk7258Image } from './bk7258-image.mjs';

const bootBaud = 115200;
const sectorSize = 4096;
const verifyBytes = 64 * 1024;
const flashProfiles = new Map([
  // Each supported NOR uses SR1 BP bits and SR2 CMP. The value indicates
  // whether its status bytes can be written separately with SPI 01h/31h.
  [0x1640c8, true],
  [0x1665c8, false],
  [0x1660cd, false],
  [0x16400b, false],
  [0x166085, true],
  [0x162085, true],
  [0x166585, true],
  [0x16411c, false],
  [0x1640ef, true],
  [0x164020, true],
  [0x1740c8, true],
  [0x1765c8, true],
  [0x1760eb, true],
  [0x1760cd, true],
  [0x1770cd, true],
  [0x17400b, false],
  [0x17600b, false],
  [0x176085, true],
  [0x172085, true],
  [0x174020, true],
]);
const protectionMasks = [0x7c, 0x40];
const responseHeader = [0x04, 0x0e];
const commandHeader = [0x01, 0xe0, 0xfc];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function word(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function readWord(bytes, offset = 0) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function commandFrame(command, payload, extended) {
  const length = payload.length + 1;
  const header = extended
    ? [...commandHeader, 0xff, 0xf4, length & 0xff, length >>> 8]
    : [...commandHeader, length];
  const frame = new Uint8Array(header.length + length);
  frame.set(header);
  frame[header.length] = command;
  frame.set(payload, header.length + 1);
  return frame;
}

class ReplyTimeout extends Error {
  constructor() {
    super('BK7258 下载串口无响应。');
  }
}

function serialCommands(port) {
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let pending;
  let closed;
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending?.accept(value);
      }
    } catch (error) {
      pending?.finish(error);
    } finally {
      pending?.finish(new Error('BK7258 下载串口已断开。'));
      reader.releaseLock();
    }
  })();

  function receive(expected, extended, timeout) {
    return new Promise((resolve, reject) => {
      let buffer = new Uint8Array();
      const finish = (error, data) => {
        clearTimeout(timer);
        pending = undefined;
        if (error) reject(error);
        else resolve(data);
      };
      const timer = setTimeout(() => finish(new ReplyTimeout()), timeout);
      pending = {
        finish,
        accept(value) {
          const incoming = new Uint8Array(buffer.length + value.length);
          incoming.set(buffer);
          incoming.set(value, buffer.length);
          buffer = incoming;
          while (buffer.length >= 3) {
            const lengthByte = buffer[2];
            const flash = lengthByte === 0xff;
            const header = flash ? 9 : 3;
            const fixed = [...responseHeader, lengthByte, ...commandHeader];
            if (flash) fixed.push(0xf4);
            if (
              !fixed
                .slice(0, buffer.length)
                .every((byte, index) => buffer[index] === byte)
            ) {
              buffer = buffer.subarray(1);
              continue;
            }
            if (buffer.length < header) return;
            const body = flash ? buffer[7] | (buffer[8] << 8) : lengthByte;
            if (body < (flash ? 2 : 4) || body > 4102) {
              buffer = buffer.subarray(1);
              continue;
            }
            if (buffer.length < header + body) return;
            const frame = buffer.subarray(0, header + body);
            buffer = buffer.subarray(frame.length);
            if (flash !== extended || frame[flash ? 9 : 6] !== expected)
              continue;
            if (flash && frame[10] !== 0) {
              const error = new Error(
                `BK7258 Flash 命令返回状态 ${frame[10]}。`,
              );
              error.status = frame[10];
              finish(error);
              return;
            }
            finish(null, frame.subarray(flash ? 11 : 7));
            return;
          }
        },
      };
    });
  }

  return {
    async exchange(
      opcode,
      payload,
      { expected = opcode, extended = false, timeout = 3000 } = {},
    ) {
      const reply = receive(expected, extended, timeout);
      try {
        const [result] = await Promise.all([
          reply,
          writer.write(commandFrame(opcode, payload, extended)),
        ]);
        return result;
      } catch (error) {
        pending?.finish(error);
        throw error;
      }
    },
    send: (opcode, data) => writer.write(commandFrame(opcode, data, false)),
    close() {
      closed ??= (async () => {
        pending?.finish(new Error('BK7258 下载串口已关闭。'));
        await reader.cancel().catch(() => {});
        await reading;
        writer.releaseLock();
        if (port.readable || port.writable) await port.close();
      })();
      return closed;
    },
  };
}

async function bootLink(commands) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) {
    try {
      const response = await commands.exchange(0x00, [], {
        expected: 0x01,
        timeout: 65,
      });
      if (response.length === 1 && response[0] === 0) return;
    } catch (error) {
      if (!(error instanceof ReplyTimeout)) throw error;
    }
  }
  throw new Error(
    '未进入 BK7258 下载模式。重新连接串口后，请在 15 秒内复位或重新给开发板上电。',
  );
}

async function readRegister(commands, address) {
  const response = await commands.exchange(0x03, word(address));
  if (response.length !== 8 || readWord(response) !== address) {
    throw new Error('BK7258 芯片识别响应无效。');
  }
  return readWord(response, 4);
}

async function flashCommand(commands, opcode, data) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await commands.exchange(opcode, data, {
        extended: true,
        timeout: 5000,
      });
    } catch (error) {
      if (error.status !== 1 || attempt === 19) throw error;
      await wait(10);
    }
  }
}

async function readStatus(commands) {
  const values = [];
  for (const opcode of [0x05, 0x35]) {
    const data = await flashCommand(commands, 0x0c, [opcode]);
    if (data.length !== 2 || data[0] !== opcode)
      throw new Error('BK7258 Flash 状态读取失败。');
    values.push(data[1]);
  }
  return values;
}

async function setStatus(commands, current, target, separate) {
  const wanted = current.map((value, index) => {
    const mask = protectionMasks[index];
    return (value & ~mask) | (target[index] & mask);
  });
  if (wanted.every((value, index) => current[index] === value)) return;
  const writes = separate
    ? [0x01, 0x31].flatMap((opcode, index) =>
        current[index] === wanted[index] ? [] : [[opcode, wanted[index]]],
      )
    : [[0x01, ...wanted]];
  for (const [opcode, ...bytes] of writes) {
    const ack = await flashCommand(commands, 0x0d, [opcode, ...bytes]);
    if (ack[0] !== opcode) throw new Error('BK7258 Flash 状态写入响应无效。');
    await wait(15);
  }
  const actual = await readStatus(commands);
  if (
    actual.some(
      (value, index) =>
        (value & protectionMasks[index]) !==
        (wanted[index] & protectionMasks[index]),
    )
  ) {
    throw new Error('BK7258 Flash 保护状态校验失败。');
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function flashCrc(data, initial) {
  let crc = initial;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc >>> 0;
}

async function program(commands, data, progress) {
  const length = Math.ceil(data.length / sectorSize) * sectorSize;
  let crc = 0xffffffff;
  let verifyStart = 0;
  for (let address = 0; address < length; address += sectorSize) {
    const location = word(address);
    const erased = await flashCommand(commands, 0x0b, location);
    if (erased.length !== 4 || readWord(erased) !== address)
      throw new Error('BK7258 擦除地址校验失败。');
    const block = new Uint8Array(sectorSize + 4).fill(0xff);
    block.set(location);
    block.set(data.subarray(address, address + sectorSize), 4);
    const payload = block.subarray(4);
    if (!payload.every((byte) => byte === 0xff)) {
      const ack = await flashCommand(commands, 0x07, block);
      if (ack.length !== 4 || readWord(ack) !== address)
        throw new Error('BK7258 写入地址校验失败。');
    }
    crc = flashCrc(payload, crc);
    const end = address + sectorSize;
    if (end - verifyStart >= verifyBytes || end === length) {
      const reply = await commands.exchange(0x10, [
        ...word(verifyStart),
        ...word(end - 1),
      ]);
      if (reply.length !== 4 || readWord(reply) !== crc) {
        throw new Error(
          `BK7258 Flash CRC 校验失败，地址 0x${verifyStart.toString(16)}。`,
        );
      }
      crc = 0xffffffff;
      verifyStart = end;
    }
    progress(end / length);
  }
}

export async function connectBk7258(port, _settings, print) {
  await port.open({ baudRate: bootBaud });
  let commands;
  try {
    commands = serialCommands(port);
    print(
      '等待下载握手。请按开发板的复位键，或保持 USB 串口连接并重新给开发板上电。\n',
    );
    await bootLink(commands);
    const version = await readRegister(commands, 0x44010004);
    const id = version & 0xffffff;
    if (
      // The LCKFB BK7258 probe reports the revision in the low 16 bits.
      version !== 0x72360101 &&
      id !== 0x7258 &&
      ((id !== 0x7236 && version >>> 16 !== 0x7236) ||
        (await readRegister(commands, 0x440001f0)) !== 0x20340b10)
    )
      throw new Error('当前设备的芯片标识不在 BK7258 支持范围内。');

    const identification = await flashCommand(commands, 0x0e, [0x9f, 0, 0, 0]);
    const mid = identification.length >= 4 ? readWord(identification) >>> 8 : 0;
    if (!flashProfiles.has(mid))
      throw new Error(
        `暂不支持此 BK7258 的 Flash 型号（JEDEC 0x${mid.toString(16)}）。`,
      );
    const capacity = 2 ** (mid >>> 16);
    print(`BK7258 下载串口已就绪，Flash JEDEC 0x${mid.toString(16)}。\n`);
    return {
      chip: 'BK7258',
      description: 'BK7258 UART0',
      capacity,
      capacityLabel: `${capacity / 1048576} MB`,
      close: () => commands.close(),
      reset: () => commands.send(0x0e, [0xa5]),
      async write(images, _options, progress) {
        const [image] = images;
        if (
          images.length !== 1 ||
          image.address !== 0 ||
          image.data.length > capacity
        ) {
          throw new Error(
            'BK7258 仅接受从 0x0 写入的完整镜像，文件不可超过 Flash 容量。',
          );
        }
        validateBk7258Image(image.data);
        const separate = flashProfiles.get(mid);
        const original = await readStatus(commands);
        print('开始擦除和写入，写入后逐段验证 Flash CRC。\n');
        let failed;
        try {
          await setStatus(commands, original, [0, 0], separate);
          await program(commands, image.data, progress);
        } catch (error) {
          failed = error;
          throw error;
        } finally {
          try {
            await setStatus(
              commands,
              await readStatus(commands),
              original,
              separate,
            );
          } catch (error) {
            print(`恢复 Flash 保护失败：${error.message}\n`);
            if (!failed) throw error;
          }
        }
        print('BK7258 写入及 CRC 校验通过。\n');
      },
    };
  } catch (error) {
    if (commands) await commands.close().catch(() => {});
    else await port.close().catch(() => {});
    throw error;
  }
}
