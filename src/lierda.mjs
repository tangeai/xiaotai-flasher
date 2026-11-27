import { LocalizedError, t, localizedMessage } from './i18n.mjs';
import {
  isDownloadPort, parseLierdaBaudrate, USB_BAUD, AGENT_SYNC, LPC_SYNC, HEAD_IMAGE,
  EMPTY, words, sendCommand, synchronize, imageInfo, sendImageData, flashImageHeader,
  connectAgent, readMemory, waitForSerialOperation,
} from './lierda-serial.mjs';
import { loadLierdaAgentBoot } from './lierda-agentboot.mjs';
import { readLierdaFlashIdentity } from './lierda-recovery.mjs';
import { readPmApplicationModel } from './lierda-pm-identity.mjs';
import { configurePmProExternal, preparePmProExternalWrite, readPmProExternal } from './lierda-spi.mjs';
import {
  flashBase as AP_XIP_BASE, hexBytes as bytesHex, lierdaSha256 as sha256,
  lierdaBootFingerprintAddress, lierdaFingerprintLength, lierdaBootCandidates, matchLierdaBootFingerprint,
  matchesLierdaApplicationLayout, matchLierdaDeviceLayout, getLierdaHardwareProfile,
  parseLierdaPackage, getLierdaFlashPlan, validateHmBootHeaders, validatePmProBootHeaders,
} from './lierda-package.mjs';

const FLASH_ERASE = 0x10;
const BURN_PREPARE = 0x42;
const BURN_STATUS = 0x44;
const SYSTEM_RESET = 0xaa;
const ERASE_REQUEST_SIZE = 0x1000;
const WRITE_BLOCK_SIZE = 0x10000;
const MAX_READ_SIZE = 240;
const REPORT_INTERVAL = 0x80000;

class LierdaCompatibilityError extends LocalizedError {}
class UnknownPmApplication extends LierdaCompatibilityError {}

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

async function installedPmModel(profile, header, readFlash) {
  const sharedApp = getLierdaHardwareProfile('pro-pm').app;
  if (profile.chip === 'EC718PM' && matchesLierdaApplicationLayout(header, sharedApp)) {
    return readPmApplicationModel(header, sharedApp, readFlash);
  }
}

async function verifyCurrentBase(backup, hardware) {
  for (const { role, address, capacity, digest } of hardware.baseImages) {
    const current = backup.subarray(address, address + capacity);
    if (await sha256(current) !== digest) {
      throw new LocalizedError(localizedMessage('当前 @0 与已识别的设备底包不一致。', role));
    }
  }
  const appHeader = backup.subarray(hardware.app.address, hardware.app.address + 24);
  if (!matchesLierdaApplicationLayout(appHeader, hardware.app)) {
    throw new LocalizedError(localizedMessage('当前设备的应用和文件系统布局与 @0 不匹配。', localizedMessage(hardware.boardLabel)));
  }
  if (hardware.chip === 'EC718PM') {
    const model = await installedPmModel(hardware, appHeader, (offset, length) => backup.subarray(offset, offset + length));
    const base = getLierdaHardwareProfile('lite');
    if (matchLierdaDeviceLayout(base, appHeader, model) !== hardware) {
      throw new LocalizedError('设备当前的应用标识与连接时不一致，请重新连接。');
    }
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
  const external = image.role === 'EXT';
  if (external) {
    await preparePmProExternalWrite(io, image);
  } else {
    await synchronize(io, LPC_SYNC, "LPC");
    await sendCommand(io, BURN_PREPARE, words(image.imageId), { lpc: true });
  }
  await synchronize(io, AGENT_SYNC, "AGBOOT");
  await synchronize(io, AGENT_SYNC, "AGBOOT");
  await imageInfo(io, HEAD_IMAGE, image.role + " HEAD", log, true);
  const header = await flashImageHeader(image);
  log(t('@0 写入 @1 · @2 字节 · 镜像头 SHA-256 @3', image.role, hexAddress(external ? 0 : image.address), image.data.length, bytesHex(header.subarray(32, 64))));
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
  for (const { start, end, digest } of preservedRanges) {
    const actual = await readRange(io, start, end - start, (done) => onProgress(checked + done));
    if (await sha256(actual) !== (digest ?? await sha256(backup.subarray(start, end)))) {
      throw new LocalizedError(localizedMessage('保留区与擦除前备份不一致 · @0', hexAddress(start)));
    }
    checked += end - start;
  }
}

function pmProRecoveryRanges(hardware, record) {
  const { address, fsStart, fsSize } = hardware.app;
  const fsEnd = fsStart + fsSize;
  if (record.stage === 'external') {
    // The original APP may have run again. Every byte except its writable FS must still match.
    return [{ start: 0, end: fsStart }, { start: fsEnd, end: hardware.size }];
  }
  if (!record.fsDigest) return hardware.preservedRanges;
  return [{ start: 0, end: address }, { start: fsStart, end: fsEnd, digest: record.fsDigest },
    { start: fsEnd, end: hardware.size }];
}

async function readBackup(io, hardware, plan, saveBackup, log, onProgress) {
  if (typeof saveBackup !== 'function') throw new LocalizedError('需要配置 Flash 备份保存位置。');
  await synchronize(io, LPC_SYNC, 'LPC');
  log(t('回读烧录前的内部 Flash · @0 MiB。', hardware.size / 0x100000));
  const total = hardware.size + (hardware.externalSize ?? 0);
  const internal = await readRange(io, 0, hardware.size, done => onProgress(done, total));
  await verifyCurrentBase(internal, hardware);
  if (hardware.model === 'pro-pm') await validatePmProBootHeaders(internal);
  if (plan.profile.chip === 'EC718HM' && hardware !== plan.profile) await validateHmBootHeaders(internal, hardware);
  let bytes = internal;
  if (hardware.externalSize) {
    log(t('回读烧录前的 SPI1 外置 Flash · @0 MiB。', hardware.externalSize / 0x100000));
    const external = await readPmProExternal(io, 0, hardware.externalSize,
      done => onProgress(internal.length + done, total));
    bytes = new Uint8Array(total);
    bytes.set(internal);
    bytes.set(external, internal.length);
  }
  const digest = await sha256(bytes);
  const saved = await saveBackup(bytes.slice(), digest);
  const location = typeof saved === 'string' ? saved : saved?.location;
  if (typeof location !== 'string' || !location) throw new LocalizedError('Flash 备份未确认保存。');
  return { bytes, digest, location, name: saved?.name, packageSha: plan.sha256 };
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

async function verifyReinstall(io, backup, flashPlan, firmware, progress) {
  const expected = backup.slice();
  for (const { start, end } of flashPlan.eraseRanges) expected.fill(0xff, start, end);
  for (const { data, address } of firmware.images) expected.set(data, address);
  await synchronize(io, LPC_SYNC, 'LPC');
  const actual = await readRange(io, 0, expected.length, progress);
  // AgentBoot generates the two boot headers from the new BL and AP, independently of the BINPKG payloads.
  await validateHmBootHeaders(actual, firmware.profile);
  for (let offset = 0x2000; offset < actual.length; offset++) {
    if (actual[offset] !== expected[offset]) {
      throw new LocalizedError(localizedMessage('整包重装回读不一致 · @0', hexAddress(offset)));
    }
  }
}

async function detectLierdaHardware(io, log) {
  const bootloader = await readMemory(io, AP_XIP_BASE + lierdaBootFingerprintAddress, lierdaFingerprintLength);
  const bootDigest = await sha256(bootloader);
  const candidates = lierdaBootCandidates(bootDigest);
  if (!candidates.length) {
    log(t('设备 BL 样本 SHA-256 · @0', bootDigest) + '\n');
    throw new LierdaCompatibilityError('设备的引导程序（BL）与已适配的底包不匹配，暂时无法烧录。');
  }

  // The two HM layouts share their BL sample and AP address, but have different AP images.
  const ap = candidates[0].baseImages.find(image => image.role === 'AP');
  const apSample = await readMemory(io, AP_XIP_BASE + ap.address, lierdaFingerprintLength);
  const familyLabel = candidates[0].chip === 'EC718PM' ? 'NT26F6D0 (F6D_D)' : candidates[0].boardLabel;
  const base = matchLierdaBootFingerprint(bootDigest, await sha256(apSample));
  if (!base) {
    throw new LierdaCompatibilityError(localizedMessage('当前设备的 @0 指纹与 @1 不匹配。', 'AP', familyLabel));
  }
  const cp = base.baseImages.find(image => image.role === 'CP');
  const cpSample = await readMemory(io, AP_XIP_BASE + cp.address, lierdaFingerprintLength);
  if (await sha256(cpSample) !== cp.sampleSha) {
    throw new LierdaCompatibilityError(localizedMessage('当前设备的 @0 指纹与 @1 不匹配。', 'CP', familyLabel));
  }
  const appHeader = await readMemory(io, AP_XIP_BASE + base.app.address, 24);
  const model = await installedPmModel(base, appHeader, (offset, length) => readMemory(io, AP_XIP_BASE + offset, length));
  const hardware = matchLierdaDeviceLayout(base, appHeader, model);
  if (!hardware) {
    if (base.chip === 'EC718PM') {
      throw new UnknownPmApplication('已识别 NT26F6D0，但无法从当前应用确认 Lite 或 Pro。');
    }
    throw new LierdaCompatibilityError(localizedMessage('当前设备的应用和文件系统布局与 @0 不匹配。', localizedMessage(base.boardLabel)));
  }
  if (model) log(t('当前应用的产品标识匹配 @0。\n', t(hardware.boardLabel)));
  if (hardware.applicationOnly) {
    const low = await readMemory(io, AP_XIP_BASE, 32);
    const high = await readMemory(io, AP_XIP_BASE + 0x400000, 32);
    if (high.every((byte, index) => byte === low[index])) {
      throw new LierdaCompatibilityError('内部 Flash 上半区与起始地址回读相同，无法确认 8 MiB 布局。');
    }
  }
  return hardware;
}

export async function connectLierda(port, settings, log = () => {}) {
  if (!isDownloadPort(port)) throw new LocalizedError('请选择利尔达 QDLoader 下载口（17D1:0001）。');
  const { baudrate: requestedRate = USB_BAUD, signal } = settings ?? {};
  signal?.throwIfAborted();
  const baudrate = parseLierdaBaudrate(requestedRate);
  if (baudrate === null) throw new LocalizedError('请输入 100 至 3276700 之间、且为 100 整数倍的 QDLoader 波特率。');
  const agent = settings?.agent ?? await loadLierdaAgentBoot(signal);
  signal?.throwIfAborted();
  let connection;
  let hardware;
  let compatibilityError;
  let closed = false;
  let opened = false;
  let busy = false;
  let resetAllowed = false;
  let interruptedBackup;
  const recovery = settings?.recovery;
  let recoveryRecord;
  let recoveryIdentity;
  let recoveryOnly = false;
  const close = async (abortReason) => {
    if (closed) return;
    closed = true;
    interruptedBackup = undefined;
    try {
      await connection?.close(abortReason);
    } finally {
      if (opened && (port.readable || port.writable)) {
        const closing = port.close();
        if (abortReason !== undefined) closing.catch(() => {});
        else await closing;
      }
    }
  };
  try {
    const opening = port.open({ baudRate: baudrate, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'none', bufferSize: 128 * 1024 });
    try {
      await waitForSerialOperation(opening, signal);
      opened = true;
    } catch (error) {
      // Web Serial cannot cancel open(). Close a late successful open, but
      // never close another owner's port when this open itself was rejected.
      if (signal?.aborted) opening.then(() => port.close()).catch(() => {});
      throw error;
    }
    signal?.throwIfAborted();
    await waitForSerialOperation(port.setSignals({ dataTerminalReady: true }), signal);
    connection = await connectAgent(port, agent, (line) => log(line + '\n'), baudrate, signal);
    try {
      hardware = await detectLierdaHardware(connection.io, log);
    } catch (error) {
      if (!(error instanceof LierdaCompatibilityError)) throw error;
      compatibilityError = error;
      if (error instanceof UnknownPmApplication && recovery) {
        // Recovery is reachable only after the PM BL/AP/CP fingerprints match.
        // Never reinterpret a positively identified Lite or HM device.
        try {
          recoveryIdentity = await readLierdaFlashIdentity(connection.io);
          const record = recoveryIdentity && await recovery.find(recoveryIdentity);
          if (record?.stage === 'internal') {
            const pro = getLierdaHardwareProfile('pro-pm');
            const original = await recovery.load(record);
            await verifyCurrentBase(original.bytes, pro);
            await validatePmProBootHeaders(original.bytes);
            await verifyPreserved(connection.io, original.bytes, pmProRecoveryRanges(pro, record));
            interruptedBackup = original;
            recoveryRecord = record;
            recoveryOnly = true;
            hardware = pro;
            compatibilityError = undefined;
          }
        } catch (cause) {
          signal?.throwIfAborted();
          log(t('PM Pro 续刷核对未通过。@0\n', cause));
        }
      }
    }
    if (hardware?.model === 'pro-pm' && recovery && !recoveryOnly) {
      // A runnable APP can still have an interrupted write. Read its journal
      // before offering firmware; recheck the identity and journal before writing.
      try {
        if (await recovery.hasPending()) {
          const identity = await readLierdaFlashIdentity(connection.io);
          if (identity) {
            recoveryRecord = await recovery.find(identity);
            recoveryIdentity = identity;
          }
        }
      } catch (cause) {
        signal?.throwIfAborted();
        log(t('PM Pro 续刷核对未通过。@0\n', cause));
      }
    }
    signal?.throwIfAborted();
    if (recoveryOnly) {
      log(t('已匹配本机中断的 PM Pro 烧录和原始备份，请选择同一个完整固件包继续。\n'));
    } else if (hardware) {
      log(t('@0 底包和 @1 MiB 内部 Flash 应用布局核对通过。\n', t(hardware.boardLabel), hardware.size / 0x100000));
    } else {
      log(t('下载口已连接，已禁用烧录。@0', compatibilityError) + '\n');
    }
  } catch (error) {
    await close(signal?.reason).catch(() => {});
    throw signal?.reason ?? error;
  }
  const { io } = connection;
  io.finishConnection();
  const isActive = () => !closed && port.connected !== false && port.readable && port.writable;

  return {
    chip: hardware?.chip ?? null, capacity: hardware?.size ?? null,
    capacityLabel: hardware ? hardware.size / 0x100000 + ' MiB' : null,
    lierdaModel: hardware?.model ?? null, lierdaProfile: hardware ?? null, close,
    get lierdaRecoveryBackup() { return recoveryRecord ? interruptedBackup : undefined; },
    get lierdaRecoveryPackageSha() {
      if (hardware?.model === 'pro-pm' && !resetAllowed && recoveryRecord?.stage !== 'verified') {
        return recoveryRecord?.packageSha ?? interruptedBackup?.packageSha;
      }
    },
    get lierdaCompatibilityIssue() { return compatibilityError?.message ?? ''; },
    get canRetry() { return Boolean(isActive() && !resetAllowed); },
    async writeLierda(input, { onProgress = () => {}, log: writeLog = log, saveBackup, onRecoveredBackup, allowReinstall = false } = {}) {
      if (compatibilityError) throw compatibilityError;
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
        const flashPlan = getLierdaFlashPlan(hardware, plan.profile);
        if (flashPlan.mode === 'reinstall' && allowReinstall !== true) {
          throw new LocalizedError('整包重装将清除用户数据，请先确认。');
        }
        const pmPro = flashPlan.mode === 'pm-pro';
        const updateApp = pmPro || flashPlan.mode === 'app';
        const internalImages = updateApp ? plan.images.filter(({ role }) => role === 'APP') : plan.images;
        const external = pmPro ? plan.images.find(({ role }) => role === 'EXT') : null;
        let backup = interruptedBackup;
        let resumedFsDigest;
        let targetAppMatches = false;
        let verifiedRecord;
        const finish = async () => {
          if (recoveryRecord) {
            try {
              await recovery.replace(recoveryIdentity, recoveryRecord, null);
              recoveryRecord = undefined;
            } catch {
              // Device readback has already passed. Keep reset available even if OPFS is unavailable.
              if (recoveryRecord.stage !== 'verified') {
                const verified = { ...recoveryRecord, stage: 'verified' };
                try {
                  await recovery.replace(recoveryIdentity, recoveryRecord, verified);
                  recoveryRecord = verified;
                } catch { /* The original journal still supports read-only verification with the same package. */ }
              }
              writeLog(t('设备回读校验已通过，本地续刷记录清理失败。'));
            }
          }
          interruptedBackup = undefined;
          resetAllowed = true;
          onProgress(1, '写入和回读校验完成');
          return {
            backupHash: backup.digest,
            backupLocation: backup.location,
            verifiedImages: (pmPro ? [external, ...internalImages] : internalImages)
              .map(({ role, sha, data }) => ({ role, sha256: sha, length: data.length })),
          };
        };
        if (pmPro && recovery) {
          const identity = await readLierdaFlashIdentity(io);
          if ((recoveryIdentity !== undefined && recoveryIdentity !== identity)
              || (!identity && (recoveryOnly || recoveryRecord || await recovery.hasPending()))) {
            throw new LocalizedError('无法确认 PM Pro 内部 Flash 的唯一标识，请重新连接。');
          }
          recoveryIdentity = identity;
          if (!identity) writeLog(t('当前 Flash 标识无法用于跨页续刷。如烧录中断，请保持当前连接并在本页重试。'));
          const record = identity ? await recovery.find(identity) : null;
          if (recoveryRecord && (!record || record.digest !== recoveryRecord.digest
              || record.packageSha !== recoveryRecord.packageSha || record.name !== recoveryRecord.name
              || record.stage !== recoveryRecord.stage || record.fsDigest !== recoveryRecord.fsDigest)) {
            throw new LocalizedError('PM Pro 本地续刷记录已变化，请重新连接。');
          }
          if (record?.stage === 'verified' && !recoveryOnly) verifiedRecord = record;
          if (record && (!verifiedRecord || plan.sha256 === record.packageSha)) {
            recoveryRecord = record;
            if (plan.sha256 !== record.packageSha) throw new LocalizedError('请用上次中断的固件继续烧录。');
            backup = await recovery.load(record);
            await verifyCurrentBase(backup.bytes, hardware);
            await validatePmProBootHeaders(backup.bytes);
            onRecoveredBackup?.(backup);
          }
        }
        if (backup) {
          if (plan.sha256 !== backup.packageSha || await sha256(backup.bytes) !== backup.digest) {
            throw new LocalizedError('请用上次中断的固件继续烧录。');
          }
          let checkedRecord = recoveryRecord;
          if (recoveryRecord && recoveryRecord.stage !== 'external') {
            const [app] = internalImages;
            const current = await readRange(io, app.address, app.capacity);
            targetAppMatches = await sha256(current.subarray(0, app.data.length)) === app.sha
              && current.subarray(app.data.length).every(byte => byte === 0xff);
            // A complete original or target APP may have run and updated its own filesystem.
            // For a partial APP, keep checking the filesystem against the saved checkpoint.
            if (targetAppMatches || current.every((byte, index) => byte === backup.bytes[app.address + index])) {
              const { fsStart, fsSize } = hardware.app;
              const fsDigest = await sha256(await readRange(io, fsStart, fsSize));
              const expected = recoveryRecord.fsDigest ?? await sha256(backup.bytes.subarray(fsStart, fsStart + fsSize));
              if (fsDigest !== expected) checkedRecord = { ...recoveryRecord, fsDigest };
            }
          }
          const preserved = checkedRecord ? pmProRecoveryRanges(hardware, checkedRecord) : flashPlan.preservedRanges;
          await verifyPreserved(io, backup.bytes, preserved);
          if (checkedRecord !== recoveryRecord) {
            resumedFsDigest = checkedRecord.fsDigest;
          }
          if (recoveryRecord?.stage === 'external') {
            const { fsStart, fsSize } = hardware.app;
            resumedFsDigest = await sha256(await readRange(io, fsStart, fsSize));
          }
          writeLog(t('使用上次写入前保存的完整备份。'));
        }
        if (pmPro) await configurePmProExternal(io);
        if (targetAppMatches) {
          const readback = await readPmProExternal(io, 0, hardware.externalSize);
          if (await sha256(readback) === external.sha) {
            writeLog(t('内部应用、保留区和 SPI1 资源回读通过，已完成本次续刷核验。'));
            return await finish();
          }
        }
        if (verifiedRecord) {
          // Starting a new write after a completed operation needs a new pre-write backup.
          backup = undefined;
          resumedFsDigest = undefined;
        } else if (resumedFsDigest && recoveryRecord?.stage === 'internal') {
          const next = { ...recoveryRecord, fsDigest: resumedFsDigest };
          await recovery.replace(recoveryIdentity, recoveryRecord, next);
          recoveryRecord = next;
        }
        if (!backup) {
          backup = await readBackup(io, hardware, plan, saveBackup, writeLog, (end, total) =>
            onProgress(0.05 + 0.30 * end / total, '备份原始 Flash'));
        }
        if (pmPro && recovery && recoveryIdentity && (!recoveryRecord || verifiedRecord)) {
          const record = { version: 1, identity: recoveryIdentity, stage: 'external',
            name: backup.name, digest: backup.digest, packageSha: plan.sha256 };
          await recovery.replace(recoveryIdentity, verifiedRecord ?? null, record);
          recoveryRecord = record;
        }
        interruptedBackup = backup;
        writeLog(t('备份已保存 · @0 · SHA-256 @1', backup.location, backup.digest));
        // Verify the SPI1 target before changing the bootable internal app.
        if (pmPro) {
          onProgress(0.35, '写入 SPI1 界面资源');
          await writeImage(io, external, writeLog,
            done => onProgress(0.35 + 0.18 * done / external.data.length, '写入 SPI1 界面资源'));
          const readback = await readPmProExternal(io, 0, hardware.externalSize,
            done => onProgress(0.53 + 0.08 * done / hardware.externalSize, '回读 SPI1 界面资源'));
          if (await sha256(readback) !== external.sha) {
            throw new LocalizedError(localizedMessage('@0 回读 SHA-256 不一致', 'SPI1'));
          }
          writeLog(t('@0 全镜像回读 SHA-256 一致 · @1', 'SPI1', external.sha));
          if (recoveryRecord?.stage === 'external') {
            const next = { ...recoveryRecord, stage: 'internal' };
            if (resumedFsDigest) next.fsDigest = resumedFsDigest;
            await recovery.replace(recoveryIdentity, recoveryRecord, next);
            recoveryRecord = next;
          }
        }
        const eraseStart = pmPro ? 0.61 : 0.35;
        const writeStart = pmPro ? 0.65 : 0.45;
        onProgress(eraseStart, '擦除固件区域');
        await erase(io, flashPlan.eraseRanges, writeLog,
          (end, total) => onProgress(eraseStart + (writeStart - eraseStart) * end / total, '擦除固件区域'));

        const writeSize = internalImages.reduce((sum, image) => sum + image.data.length, 0);
        let written = 0;
        for (const image of internalImages) {
          await writeImage(io, image, writeLog, (end) =>
            onProgress(writeStart + (0.75 - writeStart) * (written + end) / writeSize, localizedMessage('写入 @0', image.role)));
          written += image.data.length;
        }
        onProgress(0.75, '回读校验');
        if (flashPlan.mode === 'reinstall') {
          await verifyReinstall(io, backup.bytes, flashPlan, plan, end =>
            onProgress(0.75 + 0.24 * end / hardware.size, '回读校验'));
          writeLog(t('整包重装校验通过，出厂数据和校准区与备份一致。'));
        } else if (updateApp) {
          const [app] = internalImages;
          await verifyImages(io, internalImages, writeLog, (end) =>
            onProgress(0.75 + 0.24 * end / hardware.size, '回读应用'));
          const tailAddress = app.address + app.data.length;
          const tail = await readRange(io, tailAddress, app.capacity - app.data.length, (end) =>
            onProgress(0.75 + 0.24 * (writeSize + end) / hardware.size, '回读应用区末尾'));
          if (!tail.every((byte) => byte === 0xff)) throw new LocalizedError('应用区剩余空间未擦净。');
          const preserved = recoveryRecord ? pmProRecoveryRanges(hardware, recoveryRecord) : hardware.preservedRanges;
          await verifyPreserved(io, backup.bytes, preserved, (end) =>
            onProgress(0.75 + 0.24 * (app.capacity + end) / hardware.size, '校验应用区外数据'));
          writeLog(t('应用区外的全部内部 Flash 与烧录前一致。'));
        } else {
          await verifyImages(io, internalImages, writeLog, (end) =>
            onProgress(0.75 + 0.24 * end / writeSize, '回读校验'));
          await verifyPreserved(io, backup.bytes, hardware.preservedRanges);
          writeLog(t('引导元数据、工厂备份和校准区与烧录前一致。'));
        }
        return await finish();
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
