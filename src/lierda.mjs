import {
  isDownloadPort, USB_BAUD, AGENT_SYNC, LPC_SYNC, HEAD_IMAGE,
  EMPTY, words, sendCommand, synchronize, imageInfo, sendImageData, imageHeader,
  connectAgent, readMemory,
} from './lierda-serial.mjs';
import {
  flashBase as AP_XIP_BASE, hexBytes as bytesHex, lierdaSha256 as sha256,
  lierdaBootFingerprintAddress, lierdaFingerprintLength, matchLierdaBootFingerprint,
  matchesLierdaApplicationLayout, parseLierdaPackage,
} from './lierda-package.mjs';

const FLASH_ERASE = 0x10;
const BURN_PREPARE = 0x42;
const BURN_STATUS = 0x44;
const SYSTEM_RESET = 0xaa;
const ERASE_REQUEST_SIZE = 0x1000;
const WRITE_BLOCK_SIZE = 0x10000;
const MAX_READ_SIZE = 240;
const REPORT_INTERVAL = 0x80000;

function hexAddress(value) {
  return '0x' + value.toString(16).padStart(8, '0').toUpperCase();
}

async function readRange(io, start, length, onProgress = () => {}) {
  const data = new Uint8Array(length);
  let nextReport = REPORT_INTERVAL;
  for (let offset = 0; offset < length;) {
    const size = Math.min(MAX_READ_SIZE, length - offset);
    let block;
    try {
      block = await readMemory(io, AP_XIP_BASE + start + offset, size);
    } catch (error) {
      throw new Error("回读 " + hexAddress(AP_XIP_BASE + start + offset) + " · " + error.message,
        { cause: error });
    }
    data.set(block, offset);
    offset += size;
    if (offset >= nextReport || offset === length) {
      onProgress(offset, length);
      nextReport += REPORT_INTERVAL;
    }
  }
  return data;
}

async function verifyCurrentBase(backup, images, hardware) {
  for (const image of images.slice(0, 3)) {
    const current = backup.subarray(image.address, image.address + image.data.length);
    if (await sha256(current) !== image.sha) {
      throw new Error("当前 " + image.role + " 与所选固件的底包不一致，请先核对板卡布局");
    }
  }
  const app = images.find(({ role }) => role === "APP");
  const appHeader = backup.subarray(app.address, app.address + 24);
  if (!matchesLierdaApplicationLayout(appHeader, hardware.app)) {
    throw new Error('当前设备的应用和文件系统布局与 ' + hardware.boardLabel + ' 不匹配。');
  }
}

async function erase(io, eraseRanges, log, onProgress) {
  let erased = 0;
  const total = eraseRanges.reduce((sum, { start, end }) => sum + end - start, 0);
  for (const { start, end } of eraseRanges) {
    await synchronize(io, LPC_SYNC, "LPC");
    log("擦除物理区段 " + hexAddress(start) + " 至 " + hexAddress(end));
    let nextReport = start + REPORT_INTERVAL;
    for (let offset = start; offset < end; offset += ERASE_REQUEST_SIZE) {
      const length = Math.min(ERASE_REQUEST_SIZE, end - offset);
      try {
        await sendCommand(io, FLASH_ERASE, words(length, AP_XIP_BASE + offset), { lpc: true });
      } catch (error) {
        throw new Error("擦除 " + hexAddress(offset) + " · " + error.message, { cause: error });
      }
      erased += length;
      if (offset + length >= nextReport || offset + length === end) {
        onProgress(erased, total);
        log("已擦除至 " + hexAddress(offset + length));
        nextReport += REPORT_INTERVAL;
      }
    }
    for (const address of [start, end - 16]) {
      const sample = await readMemory(io, AP_XIP_BASE + address, 16);
      if (!sample.every((byte) => byte === 0xff)) {
        throw new Error("擦除抽检未通过 · " + hexAddress(address));
      }
    }
  }
}

async function writeImage(io, image, log, onProgress) {
  await synchronize(io, LPC_SYNC, "LPC");
  await sendCommand(io, BURN_PREPARE, words(image.imageId), { lpc: true });
  await synchronize(io, AGENT_SYNC, "AGBOOT");
  await synchronize(io, AGENT_SYNC, "AGBOOT");
  await imageInfo(io, HEAD_IMAGE, image.role + " HEAD", log, true);
  const header = await imageHeader(image.data.length, image.digest, {
    id: image.imageId,
    address: image.address,
    baud: 0,
    // This reproduces the factory USB header for EC718PM images and EC718HM APP.
    controls: 4,
  });
  log(image.role + " 写入 " + hexAddress(image.address) + " · " + image.data.length
    + " 字节 · 镜像头 SHA-256 " + bytesHex(header.subarray(32, 64)));
  await sendImageData(io, header, true);
  for (let offset = 0; offset < image.data.length; offset += WRITE_BLOCK_SIZE) {
    await synchronize(io, AGENT_SYNC, "AGBOOT");
    await imageInfo(io, image.imageId, image.role, log, true);
    const end = Math.min(offset + WRITE_BLOCK_SIZE, image.data.length);
    try {
      await sendImageData(io, image.data.subarray(offset, end), true);
    } catch (error) {
      throw new Error(image.role + " 写入偏移 " + hexAddress(offset) + " · " + error.message,
        { cause: error });
    }
    if (end === image.data.length || end % REPORT_INTERVAL === 0) {
      onProgress(end);
      log(image.role + " 已发送 " + end + "/" + image.data.length + " 字节");
    }
  }
  const result = await sendCommand(io, BURN_STATUS, EMPTY, { lpc: true });
  if (result.length !== 4 || result.some((byte) => byte !== 0)) {
    throw new Error(image.role + " 写入状态异常 · " + bytesHex(result, " "));
  }
  log(image.role + " 设备写入状态通过");
}

async function verifyPreserved(io, backup, preservedRanges, onProgress = () => {}) {
  await synchronize(io, LPC_SYNC, 'LPC');
  let checked = 0;
  for (const { start, end } of preservedRanges) {
    const actual = await readRange(io, start, end - start, (done) => onProgress(checked + done));
    if (await sha256(actual) !== await sha256(backup.subarray(start, end))) {
      throw new Error('保留区与擦除前备份不一致 · ' + hexAddress(start));
    }
    checked += end - start;
  }
}

async function readBackup(io, hardware, plan, saveBackup, log, onProgress) {
  if (typeof saveBackup !== 'function') throw new Error('需要配置 Flash 备份保存位置。');
  await synchronize(io, LPC_SYNC, 'LPC');
  log('回读烧录前的内部 Flash · ' + hardware.size / 0x100000 + ' MiB。');
  const bytes = await readRange(io, 0, hardware.size, onProgress);
  await verifyCurrentBase(bytes, plan.images, hardware);
  const digest = await sha256(bytes);
  const location = await saveBackup(bytes.slice(), digest);
  if (typeof location !== 'string' || !location) throw new Error('Flash 备份未确认保存。');
  return { bytes, digest, location, packageSha: plan.sha256 };
}

async function verifyImages(io, images, log, progress) {
  let verified = 0;
  for (const image of images) {
    await synchronize(io, LPC_SYNC, 'LPC');
    const actual = await readRange(io, image.address, image.data.length,
      (end) => progress(verified + end));
    if (await sha256(actual) !== image.sha) throw new Error(image.role + ' 回读 SHA-256 不一致');
    verified += image.data.length;
    log(image.role + ' 全镜像回读 SHA-256 一致 · ' + image.sha);
  }
}

async function detectLierdaHardware(io) {
  const bootloader = await readMemory(io, AP_XIP_BASE + lierdaBootFingerprintAddress, lierdaFingerprintLength);
  const hardware = matchLierdaBootFingerprint(await sha256(bootloader));
  if (!hardware) throw new Error('无法识别设备的 BL 指纹。支持 NT26F6D0 Lite (F6D_D) 和 NT26F9D0 Pro (F9D_D)。');

  for (const { role, address, sampleSha } of hardware.baseImages.slice(1)) {
    const sample = await readMemory(io, AP_XIP_BASE + address, lierdaFingerprintLength);
    if (await sha256(sample) !== sampleSha) {
      throw new Error('当前设备的 ' + role + ' 指纹与 ' + hardware.boardLabel + ' 不匹配。');
    }
  }
  const appHeader = await readMemory(io, AP_XIP_BASE + hardware.app.address, 24);
  if (!matchesLierdaApplicationLayout(appHeader, hardware.app)) {
    throw new Error('当前设备的应用和文件系统布局与 ' + hardware.boardLabel + ' 不匹配。');
  }
  if (hardware.applicationOnly) {
    const low = await readMemory(io, AP_XIP_BASE, 32);
    const high = await readMemory(io, AP_XIP_BASE + 0x400000, 32);
    if (high.every((byte, index) => byte === low[index])) {
      throw new Error('内部 Flash 上半区与起始地址回读相同，无法确认 8 MiB 布局。');
    }
  }
  return hardware;
}

export async function connectLierda(port, _settings, log = () => {}) {
  if (!isDownloadPort(port)) throw new Error('请选择利尔达 QDLoader 下载口（17D1:0001）。');
  const url = new URL('./lierda/agentboot-ec718pm-usb.bin', globalThis.document?.baseURI ?? import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法加载 USB AgentBoot · HTTP ' + response.status);
  const agent = new Uint8Array(await response.arrayBuffer());
  let connection;
  let hardware;
  let closed = false;
  let busy = false;
  let resetAllowed = false;
  let interruptedBackup;
  const close = async () => {
    if (closed) return;
    closed = true;
    interruptedBackup = undefined;
    try {
      await connection?.close();
    } finally {
      if (port.readable || port.writable) await port.close();
    }
  };
  try {
    await port.open({ baudRate: USB_BAUD, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'none' });
    await port.setSignals({ dataTerminalReady: true });
    connection = await connectAgent(port, agent, (line) => log(line + '\n'));
    hardware = await detectLierdaHardware(connection.io);
    log(hardware.boardLabel + ' 底包和 ' + hardware.size / 0x100000 + ' MiB Flash 布局核对通过。\n');
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const { io } = connection;
  const isActive = () => !closed && port.connected !== false && port.readable && port.writable;

  return {
    chip: hardware.chip, capacity: hardware.size, capacityLabel: hardware.size / 0x100000 + ' MiB',
    lierdaModel: hardware.model, close,
    get canRetry() { return Boolean(isActive() && !resetAllowed); },
    async writeLierda(input, { onProgress = () => {}, log: writeLog = log, saveBackup } = {}) {
      if (!isActive() || busy || resetAllowed) throw new Error('设备当前无法开始写入。');
      busy = true;
      try {
        onProgress(0.02, '校验固件');
        const { bytes, board, model, stage, filename, sha256: expectedSha } = input;
        const target = model ?? board;
        if (target !== hardware.model) {
          throw new Error('所选固件与当前连接的利尔达板型不匹配。');
        }
        const plan = await parseLierdaPackage(bytes, { model: target, stage, filename, sha256: expectedSha });
        const writeImages = hardware.applicationOnly ? plan.images.filter(({ role }) => role === 'APP') : plan.images;
        let backup = interruptedBackup;
        if (backup) {
          if (plan.sha256 !== backup.packageSha || await sha256(backup.bytes) !== backup.digest) {
            throw new Error('请用上次中断的固件继续烧录。');
          }
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges);
          writeLog('使用本次连接上次写入前的完整备份。');
        } else {
          backup = await readBackup(io, hardware, plan, saveBackup, writeLog, (end, total) =>
            onProgress(0.05 + 0.30 * end / total, '备份原始 Flash'));
        }
        interruptedBackup = backup;
        writeLog('备份已保存 · ' + backup.location + ' · SHA-256 ' + backup.digest);
        onProgress(0.35, '擦除固件区域');
        await erase(io, hardware.eraseRanges, writeLog,
          (end, total) => onProgress(0.35 + 0.10 * end / total, '擦除固件区域'));

        const writeSize = writeImages.reduce((sum, image) => sum + image.data.length, 0);
        let written = 0;
        for (const image of writeImages) {
          await writeImage(io, image, writeLog, (end) =>
            onProgress(0.45 + 0.30 * (written + end) / writeSize, '写入 ' + image.role));
          written += image.data.length;
        }
        onProgress(0.75, '回读校验');
        if (hardware.applicationOnly) {
          const [app] = writeImages;
          await verifyImages(io, writeImages, writeLog, (end) =>
            onProgress(0.75 + 0.24 * end / hardware.size, '回读应用'));
          const tailAddress = app.address + app.data.length;
          const tail = await readRange(io, tailAddress, app.capacity - app.data.length, (end) =>
            onProgress(0.75 + 0.24 * (writeSize + end) / hardware.size, '回读应用区末尾'));
          if (!tail.every((byte) => byte === 0xff)) throw new Error('应用区剩余空间未擦净。');
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges, (end) =>
            onProgress(0.75 + 0.24 * (app.capacity + end) / hardware.size, '校验应用区外数据'));
          writeLog('应用区外的全部内部 Flash 与烧录前一致。');
        } else {
          await verifyImages(io, writeImages, writeLog, (end) =>
            onProgress(0.75 + 0.24 * end / writeSize, '回读校验'));
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges);
          writeLog('引导元数据、工厂备份和校准区与烧录前一致。');
        }
        interruptedBackup = undefined;
        resetAllowed = true;
        onProgress(1, '写入和回读校验完成');
        return {
          backupHash: backup.digest,
          backupLocation: backup.location,
          verifiedImages: writeImages.map(({ role, sha, data }) => ({ role, sha256: sha, length: data.length })),
        };
      } finally {
        busy = false;
      }
    },
    async reset() {
      if (!isActive() || busy || !resetAllowed) throw new Error('请先完成写入和回读校验。');
      busy = true;
      try {
        await synchronize(io, LPC_SYNC, 'LPC');
        const ack = await sendCommand(io, SYSTEM_RESET, EMPTY, { lpc: true });
        if (bytesHex(ack) !== '5a7a5a7a5a7a5a7a') {
          throw new Error('复位响应不匹配 · ' + bytesHex(ack, ' '));
        }
        resetAllowed = false;
      } finally {
        busy = false;
      }
    },
  };
}
