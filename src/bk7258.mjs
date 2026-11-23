import { validateBk7258Image } from './bk7258-image.mjs';
import { releaseSerialControlLines } from './serial-signals.mjs';
import { bkWriteRates } from './settings.mjs';

const bootBaud = 115200;
const bootTimeout = 15000;
const bootProbeInterval = 8;
const sectorSize = 4096;
const serialBufferSize = 65536;
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
  let readError;
  let receivedBytes = 0;
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.length;
        pending?.accept(value);
      }
    } catch (error) {
      readError = error;
    } finally {
      readError ??= new Error('BK7258 下载串口已断开。');
      pending?.finish(readError);
      reader.releaseLock();
    }
  })();

  function receive(expected, extended, timeout, accept) {
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
            const data = frame.subarray(flash ? 11 : 7);
            if (accept && !accept(data)) continue;
            finish(null, data);
            return;
          }
        },
      };
    });
  }

  return {
    get receivedBytes() {
      return receivedBytes;
    },
    listen(opcode, timeout, accept) {
      if (readError) throw readError;
      return receive(opcode, false, timeout, accept);
    },
    async exchange(
      opcode,
      payload,
      {
        expected = opcode,
        extended = false,
        timeout = 3000,
        retryEvery = 0,
        accept,
      } = {},
    ) {
      if (readError) throw readError;
      let settled = false;
      const reply = receive(expected, extended, timeout, accept).finally(() => {
        settled = true;
      });
      const frame = commandFrame(opcode, payload, extended);
      const send = async () => {
        await writer.write(frame);
        while (retryEvery && !settled) {
          await wait(retryEvery);
          if (!settled) await writer.write(frame);
        }
      };
      try {
        const [result] = await Promise.all([reply, send()]);
        return result;
      } catch (error) {
        pending?.finish(error);
        throw error;
      }
    },
    send: (opcode, data) => writer.write(commandFrame(opcode, data, false)),
    close({ drain = false } = {}) {
      closed ??= (async () => {
        pending?.finish(new Error('BK7258 下载串口已关闭。'));
        try {
          if (drain) await writer.close();
        } finally {
          await reader.cancel().catch(() => {});
          await reading;
          writer.releaseLock();
          if (port.readable || port.writable) await port.close();
        }
      })();
      return closed;
    },
  };
}

async function releaseResetSignals(port, print) {
  if (!port.setSignals) return;
  try {
    await releaseSerialControlLines(port);
  } catch {
    print('无法释放串口 RTS/DTR，请检查 USB 串口驱动。\n');
  }
}

async function holdBootReset(port, print) {
  if (!port.setSignals) return;
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await wait(200);
  } catch {
    print('串口 RTS 自动复位不可用，请手动复位。\n');
  }
  return () => releaseResetSignals(port, print);
}

function probeBootrom(commands, timeout) {
  return commands.exchange(0x00, [], {
    expected: 0x01,
    timeout,
    retryEvery: bootProbeInterval,
    accept: (data) => data.length === 1 && data[0] === 0,
  });
}

async function bootLink(commands, port, print, autoReset) {
  const releaseReset = autoReset ? await holdBootReset(port, print) : undefined;
  // Start the probe before releasing reset so we can catch the BootROM window.
  const probe = probeBootrom(commands, bootTimeout);
  const release = autoReset
    ? releaseReset?.()
    : releaseResetSignals(port, print);
  try {
    await Promise.all([probe, release]);
  } catch (error) {
    if (!(error instanceof ReplyTimeout)) throw error;
    const received = commands.receivedBytes;
    throw new Error(
      received
        ? `串口收到 ${received} 字节，但没有 BK7258 下载应答。确认选中 DL_UART0，并用芯片复位键或电源开关重试。`
        : 'BK7258 下载串口未收到数据。请确认选中 DL_UART0，并保持 USB 串口连线再复位或重新给板供电。',
    );
  } finally {
    await release;
  }
}

async function readRegister(commands, address, timeout) {
  const response = await commands.exchange(0x03, word(address), { timeout });
  if (response.length !== 8 || readWord(response) !== address) {
    throw new Error('BK7258 芯片识别响应无效。');
  }
  return readWord(response, 4);
}

function commandFailure(operation, commands, receivedBefore, error) {
  const received = commands.receivedBytes - receivedBefore;
  return new Error(
    `${operation}失败（收到 ${received} 字节）：${error.message}`,
    {
      cause: error,
    },
  );
}

async function flashCommand(commands, opcode, data, operation, timeout = 5000) {
  const receivedBefore = commands.receivedBytes;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await commands.exchange(opcode, data, {
        extended: true,
        timeout,
      });
    } catch (error) {
      if (error.status !== 1 || attempt === 19)
        throw commandFailure(operation, commands, receivedBefore, error);
      await wait(10);
    }
  }
}

async function readStatus(commands) {
  const values = [];
  for (const opcode of [0x05, 0x35]) {
    const data = await flashCommand(
      commands,
      0x0c,
      [opcode],
      `读取 Flash 状态寄存器（SPI 0x${opcode.toString(16).padStart(2, '0')}）`,
    );
    if (data.length !== 2 || data[0] !== opcode)
      throw new Error('BK7258 Flash 状态读取失败。');
    values.push(data[1]);
  }
  return values;
}

async function setStatus(commands, current, target, separate, readCurrentStatus) {
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
    try {
      const ack = await flashCommand(
        commands,
        0x0d,
        [opcode, ...bytes],
        `写入 Flash 状态寄存器（SPI 0x${opcode.toString(16).padStart(2, '0')}）`,
      );
      if (ack[0] !== opcode) throw new Error('BK7258 Flash 状态写入响应无效。');
    } catch (error) {
      if (!(error.cause instanceof ReplyTimeout)) throw error;
      // A write may have finished even when its acknowledgement was lost.
      const actual = await readCurrentStatus();
      const start = opcode === 0x31 ? 1 : 0;
      if (bytes.some((value, i) => (actual[start + i] ^ value) & protectionMasks[start + i]))
        throw error;
    }
    await wait(15);
  }
  const actual = await readCurrentStatus();
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

const blankCrc = new Map(
  [sectorSize, verifyBytes].map((size) => [
    size,
    flashCrc(new Uint8Array(size).fill(0xff), 0xffffffff),
  ]),
);

async function readFlashCrc(commands, address, length) {
  const end = address + length - 1;
  const range = `0x${address.toString(16)}–0x${end.toString(16)}`;
  const receivedBefore = commands.receivedBytes;
  try {
    const reply = await commands.exchange(0x10, [
      ...word(address),
      ...word(end),
    ]);
    if (reply.length !== 4) throw new Error('CRC 应答长度无效。');
    return readWord(reply);
  } catch (error) {
    throw commandFailure(
      `读取 Flash CRC（${range}）`,
      commands,
      receivedBefore,
      error,
    );
  }
}

async function eraseFlash(commands, address, size, print) {
  const block = size === verifyBytes;
  const where = `0x${address.toString(16)}`;
  const location = word(address);
  const addressOffset = block ? 1 : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await flashCommand(
        commands,
        block ? 0x0f : 0x0b,
        block ? [0xd8, ...location] : location,
        `擦除 Flash 地址 ${where}（${size / 1024} KiB）`,
        block ? 10000 : 7000,
      );
      if (
        reply.length !== addressOffset + 4 ||
        (block && reply[0] !== 0xd8) ||
        readWord(reply, addressOffset) !== address
      )
        throw new Error(`BK7258 擦除响应校验失败，地址 ${where}。`);
      return;
    } catch (error) {
      if (!(error.cause instanceof ReplyTimeout) || attempt === 1) throw error;
      print(`擦除 ${where} 应答超时，正在检查该区域。\n`);
      if (
        (await readFlashCrc(commands, address, size)) === blankCrc.get(size)
      ) {
        print(`已确认 ${where} 区域擦除完成，继续烧录。\n`);
        return;
      }
      print(`正在重试擦除 ${where} 区域。\n`);
    }
  }
}

async function writeSector(commands, address, frame, print) {
  const where = `0x${address.toString(16)}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await flashCommand(
        commands,
        0x07,
        frame,
        `写入 Flash 地址 ${where}`,
      );
      if (reply.length !== 4 || readWord(reply) !== address)
        throw new Error(`BK7258 写入响应校验失败，地址 ${where}。`);
      return;
    } catch (error) {
      if (!(error.cause instanceof ReplyTimeout) || attempt === 1) throw error;
      print(`写入 ${where} 应答超时，正在校验该扇区。\n`);
      const actual = await readFlashCrc(commands, address, sectorSize);
      const expected = flashCrc(frame.subarray(4), 0xffffffff);
      if (actual === expected) {
        print(`已确认 ${where} 扇区写入正确，继续烧录。\n`);
        return;
      }
      print(`正在重写 ${where} 扇区。\n`);
      if (actual !== blankCrc.get(sectorSize))
        await eraseFlash(commands, address, sectorSize, print);
    }
  }
}

async function program(commands, data, progress, print) {
  const length = Math.ceil(data.length / sectorSize) * sectorSize;
  let crc = 0xffffffff;
  let verifyStart = 0;
  let erasedUntil = 0;
  for (let address = 0; address < length; address += sectorSize) {
    if (address === erasedUntil) {
      const size =
        address % verifyBytes === 0 && length - address >= verifyBytes
          ? verifyBytes
          : sectorSize;
      await eraseFlash(commands, address, size, print);
      erasedUntil += size;
    }
    const block = new Uint8Array(sectorSize + 4).fill(0xff);
    block.set(word(address));
    block.set(data.subarray(address, address + sectorSize), 4);
    const payload = block.subarray(4);
    if (!payload.every((byte) => byte === 0xff))
      await writeSector(commands, address, block, print);
    crc = flashCrc(payload, crc);
    const end = address + sectorSize;
    if (end - verifyStart >= verifyBytes || end === length) {
      if (
        (await readFlashCrc(commands, verifyStart, end - verifyStart)) !== crc
      ) {
        throw new Error(
          `BK7258 Flash CRC 校验失败，地址 0x${verifyStart.toString(16)}。`,
        );
      }
      crc = 0xffffffff;
      verifyStart = end;
    }
    if (address === 0) print('首个 Flash 扇区擦写完成。\n');
    progress(end / length);
  }
}

export async function connectBk7258(port, settings = {}, print) {
  await port.open({ baudRate: bootBaud, bufferSize: serialBufferSize });
  let commands;
  let closing = false;
  let currentBaud = bootBaud;
  async function close() {
    closing = true;
    if (commands) await commands.close();
    else if (port.readable || port.writable) await port.close();
  }
  async function reopen(baudRate, drain = false) {
    await commands?.close({ drain });
    commands = undefined;
    if (closing) throw new Error('烧录串口已断开。');
    await port.open({ baudRate, bufferSize: serialBufferSize });
    // Chromium on Windows enables DTR and RTS when it opens a serial handle.
    // Release both again so an RTS-wired board can leave reset after reopening.
    if (!closing) await releaseResetSignals(port, print);
    if (closing) {
      await port.close().catch(() => {});
      throw new Error('烧录串口已断开。');
    }
  }
  try {
    commands = serialCommands(port);
    const info = port.getInfo?.();
    if (info?.usbVendorId != null && info?.usbProductId != null) {
      print(
        `下载串口 USB VID:PID ${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId.toString(16).padStart(4, '0')}。\n`,
      );
    }
    const autoReset = settings.before !== 'manual';
    print(
      '等待下载握手（DL_UART0）。请在 15 秒内按一下板上的 RESET 键。' +
        (autoReset ? '如已通过 RTS 自动连接，可跳过此步。' : '') + '\n',
    );
    await bootLink(commands, port, print, autoReset);
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

    async function readFlashId() {
      const identification = await flashCommand(
        commands,
        0x0e,
        [0x9f, 0, 0, 0],
        '读取 Flash JEDEC',
      );
      return identification.length >= 4 ? readWord(identification) >>> 8 : 0;
    }
    const mid = await readFlashId();
    if (!flashProfiles.has(mid))
      throw new Error(
        `暂不支持此 BK7258 的 Flash 型号（JEDEC 0x${mid.toString(16)}）。`,
      );
    const capacity = 2 ** (mid >>> 16);
    print(`BK7258 下载串口已就绪，Flash JEDEC 0x${mid.toString(16)}。\n`);
    async function readCurrentStatus() {
      try {
        return await readStatus(commands);
      } catch (error) {
        if (!(error.cause instanceof ReplyTimeout)) throw error;
        print(`${error.message} 正在以 ${currentBaud} 波特率回读芯片 ID。\n`);
        let actual;
        try {
          actual = await readRegister(commands, 0x44010004, 1000);
        } catch (probeError) {
          throw new Error(
            `${error.message} 回读芯片 ID 也失败：${probeError.message} 请重新连接 DL_UART0 后重试。`,
            { cause: probeError },
          );
        }
        if (actual !== version)
          throw new Error('回读的 BK7258 芯片 ID 与连接时不一致，请重新连接。');
        print('芯片 ID 已确认，重试读取 Flash 状态寄存器。\n');
        return readStatus(commands);
      }
    }
    async function setWriteBaud(baudrate) {
      if (!bkWriteRates.includes(baudrate))
        throw new Error('请选择有效的 BK7258 烧录波特率。');
      if (baudrate === currentBaud) return;
      const targetSwitchDelay = 200;
      let switchedCommands;
      try {
        print(`正在切换 BK7258 烧录波特率到 ${baudrate}。\n`);
        // Web Serial drains the output only when its writable stream closes.
        await commands.send(0x0f, [...word(baudrate), targetSwitchDelay]);
        const sentAt = performance.now();
        await reopen(baudrate, true);
        commands = serialCommands(port);
        switchedCommands = commands;
        const reopenMs = Math.round(performance.now() - sentAt);
        print(
          `浏览器已按 ${baudrate} 重开串口并尝试释放 RTS/DTR（耗时 ${reopenMs} ms），等待设备切速应答。\n`,
        );
        try {
          await commands.listen(
            0x0f,
            400,
            (data) =>
              data.length === 5 &&
              readWord(data) === baudrate &&
              data[4] === targetSwitchDelay,
          );
          print('已收到 BK7258 切速应答。\n');
        } catch (error) {
          if (!(error instanceof ReplyTimeout)) throw error;
          print('未收到匹配的切速应答，正在用下载握手确认新速率。\n');
          await probeBootrom(commands, 750);
        }
        if ((await readRegister(commands, 0x44010004, 750)) !== version)
          throw new Error('切换后设备标识不匹配。');
        currentBaud = baudrate;
        print(`已确认 BK7258 烧录波特率 ${baudrate}。\n`);
      } catch (error) {
        if (switchedCommands) {
          print(`切速后串口收到 ${switchedCommands.receivedBytes} 字节。\n`);
          if (!closing && error instanceof ReplyTimeout) {
            try {
              await reopen(currentBaud);
              commands = serialCommands(port);
              await probeBootrom(commands, 350);
              if ((await readRegister(commands, 0x44010004, 350)) !== version)
                throw new Error('芯片 ID 不匹配。');
              if ((await readFlashId()) !== mid)
                throw new Error('Flash JEDEC 与连接时不匹配。');
              print(`回到原速率后仍能在 ${currentBaud} 读到相同芯片 ID 和 Flash JEDEC，将按此速率继续烧录。\n`);
              return;
            } catch (probeError) {
              print(
                `原速率 ${currentBaud} 回探也未确认通信：${probeError.message}\n`,
              );
            }
          }
        }
        throw new Error(
          `BK7258 无法确认 ${baudrate} 波特率。请调低速率并重新连接。${error.message}`,
          { cause: error },
        );
      }
    }
    return {
      chip: 'BK7258',
      description: 'BK7258 UART0',
      capacity,
      capacityLabel: `${capacity / 1048576} MB`,
      close,
      async reset() {
        await commands.send(0x0e, [0xa5]);
        await commands.close({ drain: true });
        print('已发送 BK7258 复位命令。请在串口日志确认固件启动。\n');
        return '已发送复位命令。请在串口日志确认启动。';
      },
      async write(images, { baudrate = bootBaud } = {}, progress) {
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
        await setWriteBaud(baudrate);
        const separate = flashProfiles.get(mid);
        const original = await readCurrentStatus();
        const sr = original.map(
          (value) => '0x' + value.toString(16).padStart(2, '0'),
        );
        print(
          `使用 ${currentBaud} 波特率。Flash 状态 SR1=${sr[0]}，SR2=${sr[1]}，正在解除写保护。\n`,
        );
        let failed;
        try {
          await setStatus(commands, original, [0, 0], separate, readCurrentStatus);
          print('Flash 写保护检查完成，开始擦写地址 0x0。\n');
          await program(commands, image.data, progress, print);
        } catch (error) {
          failed = error;
          throw error;
        } finally {
          try {
            await setStatus(
              commands,
              await readCurrentStatus(),
              original,
              separate,
              readCurrentStatus,
            );
          } catch (error) {
            print(`恢复 Flash 保护失败：${error.message}\n`);
            if (!failed)
              throw new Error(`固件 CRC 校验通过，恢复 Flash 写保护失败：${error.message}`, { cause: error });
          }
        }
        print('BK7258 写入及 CRC 校验通过。\n');
      },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
