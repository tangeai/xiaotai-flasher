import { LocalizedError, t, localizedMessage } from './i18n.mjs';
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
      throw new LocalizedError(localizedMessage('回读 @0 · @1', hexAddress(AP_XIP_BASE + start + offset), error),
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
      throw new LocalizedError(localizedMessage('当前 @0 与所选固件的底包不一致，请先核对板卡布局', image.role));
    }
  }
  const app = images.find(({ role }) => role === "APP");
  const appHeader = backup.subarray(app.address, app.address + 24);
  if (!matchesLierdaApplicationLayout(appHeader, hardware.app)) {
    throw new LocalizedError(localizedMessage('当前设备的应用和文件系统布局与 @0 不匹配。', localizedMessage(hardware.boardLabel)));
  }
}

async function erase(io, eraseRanges, log, onProgress) {
  let erased = 0;
  const total = eraseRanges.reduce((sum, { start, end }) => sum + end - start, 0);
  for (const { start, end } of eraseRanges) {
    await synchronize(io, LPC_SYNC, "LPC");
    log(t('擦除物理区段 @0 至 @1', hexAddress(start), hexAddress(end)));
    let nextReport = start + REPORT_INTERVAL;
    for (let offset = start; offset < end; offset += ERASE_REQUEST_SIZE) {
      const length = Math.min(ERASE_REQUEST_SIZE, end - offset);
      try {
        await sendCommand(io, FLASH_ERASE, words(length, AP_XIP_BASE + offset), { lpc: true });
      } catch (error) {
        throw new LocalizedError(localizedMessage('擦除 @0 · @1', hexAddress(offset), error), { cause: error });
      }
      erased += length;
      if (offset + length >= nextReport || offset + length === end) {
        onProgress(erased, total);
        log(t('已擦除至 @0', hexAddress(offset + length)));
        nextReport += REPORT_INTERVAL;
      }
    }
    for (const address of [start, end - 16]) {
      const sample = await readMemory(io, AP_XIP_BASE + address, 16);
      if (!sample.every((byte) => byte === 0xff)) {
        throw new LocalizedError(localizedMessage('擦除抽检未通过 · @0', hexAddress(address)));
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
  log(t('@0 写入 @1 · @2 字节 · 镜像头 SHA-256 @3', image.role, hexAddress(image.address), image.data.length, bytesHex(header.subarray(32, 64))));
  await sendImageData(io, header, true);
  for (let offset = 0; offset < image.data.length; offset += WRITE_BLOCK_SIZE) {
    await synchronize(io, AGENT_SYNC, "AGBOOT");
    await imageInfo(io, image.imageId, image.role, log, true);
    const end = Math.min(offset + WRITE_BLOCK_SIZE, image.data.length);
    try {
      await sendImageData(io, image.data.subarray(offset, end), true);
    } catch (error) {
      throw new LocalizedError(localizedMessage('@0 写入偏移 @1 · @2', image.role, hexAddress(offset), error),
        { cause: error });
    }
    if (end === image.data.length || end % REPORT_INTERVAL === 0) {
      onProgress(end);
      log(t('@0 已发送 @1/@2 字节', image.role, end, image.data.length));
    }
  }
  const result = await sendCommand(io, BURN_STATUS, EMPTY, { lpc: true });
  if (result.length !== 4 || result.some((byte) => byte !== 0)) {
    throw new LocalizedError(localizedMessage('@0 写入状态异常 · @1', image.role, bytesHex(result, " ")));
  }
  log(t('@0 设备写入状态通过', image.role));
}

async function verifyPreserved(io, backup, preservedRanges, onProgress = () => {}) {
  await synchronize(io, LPC_SYNC, 'LPC');
  let checked = 0;
  for (const { start, end } of preservedRanges) {
    const actual = await readRange(io, start, end - start, (done) => onProgress(checked + done));
    if (await sha256(actual) !== await sha256(backup.subarray(start, end))) {
      throw new LocalizedError(localizedMessage('保留区与擦除前备份不一致 · @0', hexAddress(start)));
    }
    checked += end - start;
  }
}

async function readBackup(io, hardware, plan, saveBackup, log, onProgress) {
  if (typeof saveBackup !== 'function') throw new LocalizedError('需要配置 Flash 备份保存位置。');
  await synchronize(io, LPC_SYNC, 'LPC');
  log(t('回读烧录前的内部 Flash · @0 MiB。', hardware.size / 0x100000));
  const bytes = await readRange(io, 0, hardware.size, onProgress);
  await verifyCurrentBase(bytes, plan.images, hardware);
  const digest = await sha256(bytes);
  const location = await saveBackup(bytes.slice(), digest);
  if (typeof location !== 'string' || !location) throw new LocalizedError('Flash 备份未确认保存。');
  return { bytes, digest, location, packageSha: plan.sha256 };
}

async function verifyImages(io, images, log, progress) {
  let verified = 0;
  for (const image of images) {
    await synchronize(io, LPC_SYNC, 'LPC');
    const actual = await readRange(io, image.address, image.data.length,
      (end) => progress(verified + end));
    if (await sha256(actual) !== image.sha) throw new LocalizedError(localizedMessage('@0 回读 SHA-256 不一致', image.role));
    verified += image.data.length;
    log(t('@0 全镜像回读 SHA-256 一致 · @1', image.role, image.sha));
  }
}

async function detectLierdaHardware(io) {
  const bootloader = await readMemory(io, AP_XIP_BASE + lierdaBootFingerprintAddress, lierdaFingerprintLength);
  const hardware = matchLierdaBootFingerprint(await sha256(bootloader));
  if (!hardware) throw new LocalizedError('无法识别设备的 BL 指纹。支持 NT26F6D0 Lite (F6D_D) 和 NT26F9D0 Pro (F9D_D)。');

  for (const { role, address, sampleSha } of hardware.baseImages.slice(1)) {
    const sample = await readMemory(io, AP_XIP_BASE + address, lierdaFingerprintLength);
    if (await sha256(sample) !== sampleSha) {
      throw new LocalizedError(localizedMessage('当前设备的 @0 指纹与 @1 不匹配。', role, localizedMessage(hardware.boardLabel)));
    }
  }
  const appHeader = await readMemory(io, AP_XIP_BASE + hardware.app.address, 24);
  if (!matchesLierdaApplicationLayout(appHeader, hardware.app)) {
    throw new LocalizedError(localizedMessage('当前设备的应用和文件系统布局与 @0 不匹配。', localizedMessage(hardware.boardLabel)));
  }
  if (hardware.applicationOnly) {
    const low = await readMemory(io, AP_XIP_BASE, 32);
    const high = await readMemory(io, AP_XIP_BASE + 0x400000, 32);
    if (high.every((byte, index) => byte === low[index])) {
      throw new LocalizedError('内部 Flash 上半区与起始地址回读相同，无法确认 8 MiB 布局。');
    }
  }
  return hardware;
}

export async function connectLierda(port, _settings, log = () => {}) {
  if (!isDownloadPort(port)) throw new LocalizedError('请选择利尔达 QDLoader 下载口（17D1:0001）。');
  const url = new URL('./lierda/agentboot-ec718pm-usb.bin', globalThis.document?.baseURI ?? import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new LocalizedError(localizedMessage('无法加载 USB AgentBoot · HTTP @0', response.status));
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
    log(t('@0 底包和 @1 MiB Flash 布局核对通过。\n', t(hardware.boardLabel), hardware.size / 0x100000));
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
      if (!isActive() || busy || resetAllowed) throw new LocalizedError('设备当前无法开始写入。');
      busy = true;
      try {
        onProgress(0.02, '校验固件');
        const { bytes, board, model, stage, filename, sha256: expectedSha } = input;
        const target = model ?? board;
        if (target !== hardware.model) {
          throw new LocalizedError('所选固件与当前连接的利尔达板型不匹配。');
        }
        const plan = await parseLierdaPackage(bytes, { model: target, stage, filename, sha256: expectedSha });
        const writeImages = hardware.applicationOnly ? plan.images.filter(({ role }) => role === 'APP') : plan.images;
        let backup = interruptedBackup;
        if (backup) {
          if (plan.sha256 !== backup.packageSha || await sha256(backup.bytes) !== backup.digest) {
            throw new LocalizedError('请用上次中断的固件继续烧录。');
          }
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges);
          writeLog(t('使用本次连接上次写入前的完整备份。'));
        } else {
          backup = await readBackup(io, hardware, plan, saveBackup, writeLog, (end, total) =>
            onProgress(0.05 + 0.30 * end / total, '备份原始 Flash'));
        }
        interruptedBackup = backup;
        writeLog(t('备份已保存 · @0 · SHA-256 @1', backup.location, backup.digest));
        onProgress(0.35, '擦除固件区域');
        await erase(io, hardware.eraseRanges, writeLog,
          (end, total) => onProgress(0.35 + 0.10 * end / total, '擦除固件区域'));

        const writeSize = writeImages.reduce((sum, image) => sum + image.data.length, 0);
        let written = 0;
        for (const image of writeImages) {
          await writeImage(io, image, writeLog, (end) =>
            onProgress(0.45 + 0.30 * (written + end) / writeSize, localizedMessage('写入 @0', image.role)));
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
          if (!tail.every((byte) => byte === 0xff)) throw new LocalizedError('应用区剩余空间未擦净。');
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges, (end) =>
            onProgress(0.75 + 0.24 * (app.capacity + end) / hardware.size, '校验应用区外数据'));
          writeLog(t('应用区外的全部内部 Flash 与烧录前一致。'));
        } else {
          await verifyImages(io, writeImages, writeLog, (end) =>
            onProgress(0.75 + 0.24 * end / writeSize, '回读校验'));
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges);
          writeLog(t('引导元数据、工厂备份和校准区与烧录前一致。'));
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
      if (!isActive() || busy || !resetAllowed) throw new LocalizedError('请先完成写入和回读校验。');
      busy = true;
      try {
        await synchronize(io, LPC_SYNC, 'LPC');
        const ack = await sendCommand(io, SYSTEM_RESET, EMPTY, { lpc: true });
        if (bytesHex(ack) !== '5a7a5a7a5a7a5a7a') {
          throw new LocalizedError(localizedMessage('复位响应不匹配 · @0', bytesHex(ack, ' ')));
        }
        resetAllowed = false;
      } finally {
        busy = false;
      }
    },
  };
}
