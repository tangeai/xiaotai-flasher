import { LocalizedError, releaseLabel, t, localizedMessage } from './i18n.mjs';
import { useEffect, useRef, useState } from 'react';
import { createSerialPreview } from './serial-preview.mjs';
import { createAtReplyReader, encodeSerialCommand } from './serial-command.mjs';
import { startSerialRecording } from './serial-recording.mjs';
import { downloadFirmware } from './catalog.mjs';
import { loadLierdaAgentBoot } from './lierda-agentboot.mjs';
import {
  isDownloadPort, selectLierdaPort, selectLierdaDownloadPort,
  chooseLierdaDownloadPort, deferredSerialResult, requestLierdaDownloadMode, USB_BAUD, waitForSerialOperation,
} from './lierda-serial.mjs';
import { persistLierdaFlashBackup } from './lierda-workflow.mjs';
import {
  isKnownUartBridge,
  releaseSerialControlLines,
} from './serial-signals.mjs';

const serial = globalThis.isSecureContext ? navigator.serial : undefined;
const logLimit = 240000;
const serialOutputGraceMs = 400;
const initialState = {
  busy: false,
  device: null,
  deviceMessage: '尚未连接烧录串口',
  deviceError: false,
  canReconnect: false,
  needsLierdaDownloadPort: false,
  lierdaConnecting: false,
  flashBackup: null,
  monitoring: false,
  monitorReceived: false,
  monitorMessage: '',
  canSend: false,
  sending: false,
  testingAt: false,
  commandHistory: [],
  recording: false,
  preview: { text: '', offset: 0, firstLine: 0, stamps: [] },
  flashLog: '',
  tab: 'log',
  progress: null,
  complete: false,
};

export function useWorkbench() {
  const [view, setView] = useState(initialState);
  const flash = useRef(null);
  const retryPort = useRef(null);
  const lierdaBackup = useRef(null);
  const pendingLierdaDownload = useRef(null);
  const manualLierdaDownload = useRef(null);
  const lierdaConnection = useRef(null);
  const monitor = useRef(null);
  const preview = useRef(null);
  if (!preview.current) preview.current = createSerialPreview(logLimit);
  const previewTimer = useRef(null);
  const lastFlashedPort = useRef(null);
  const busy = useRef(false);
  const update = (patch) => setView((old) => ({ ...old, ...patch }));
  const flashStatus = (deviceMessage, deviceError = false) =>
    update({ deviceMessage, deviceError });
  const monitorStatus = (monitorMessage) => update({ monitorMessage });
  const setTab = (tab) => update({ tab });
  const appendLog = (key, text) => {
    if (text)
      setView((old) => ({ ...old, [key]: (old[key] + text).slice(-logLimit) }));
  };
  function flushPreview() {
    clearTimeout(previewTimer.current);
    previewTimer.current = null;
    update({ preview: preview.current.snapshot() });
  }

  function queuePreview(text) {
    if (!text) return;
    preview.current.append(text);
    if (previewTimer.current === null) previewTimer.current = setTimeout(flushPreview, 100);
  }

  const progress = (message, percent, outcome = 'writing') => {
    update({ progress: { message, percent, outcome } });
  };

  async function run(task, onError) {
    if (busy.current || !serial) return;
    busy.current = true;
    update({ busy: true });
    try {
      await task();
    } catch (error) {
      onError(
        error.name === 'NotFoundError' ? '已取消选择串口。' : error,
        error,
      );
    } finally {
      busy.current = false;
      update({ busy: false });
    }
  }

  async function releaseFlash() {
    const active = flash.current;
    flash.current = null;
    update({ device: null });
    if (active) await active.session.close();
  }

  async function releaseMonitor() {
    const active = monitor.current;
    if (!active) return;
    active.stopping = true;
    await active.reader.cancel().catch(() => {});
    await active.done;
  }

  async function stopRecording(active) {
    if (!active?.recorder) return;
    const recorder = active.recorder;
    const saved = await recorder.stop();
    if (active.recorder === recorder) {
      active.recorder = null;
      update(saved ? { recording: false, monitorMessage: '记录已结束。' } : { recording: false });
    }
  }

  function toggleRecording() {
    return run(async () => {
      const active = monitor.current;
      if (!active || active.stopping) return;
      if (active.recorder) {
        await stopRecording(active);
        return;
      }
      let directory;
      try {
        directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (error) {
        if (error.name === 'AbortError') return;
        throw error;
      }
      if (monitor.current !== active || active.stopping) return;
      active.recorder = startSerialRecording(directory, (error) => {
        update({ monitorMessage: localizedMessage('文件记录中断。@0', error) });
        void stopRecording(active);
      });
      update({ recording: true, monitorMessage: localizedMessage('正在记录到 @0，每份约 10 MiB。', directory.name) });
    }, monitorStatus);
  }

  function finishAt(active, monitorMessage) {
    clearTimeout(active.atTimer);
    active.atReply = null;
    update({ testingAt: false, monitorMessage });
  }

  async function sendCommand(command, format, ending, testAt = false) {
    const active = monitor.current;
    if (!active || active.stopping || active.writer || active.atReply || busy.current || !command) return;
    if (testAt && active.platform !== 'esp32') return;
    let writer;
    try {
      const bytes = encodeSerialCommand(command, format, ending);
      writer = active.port.writable.getWriter();
      active.writer = writer;
      if (testAt) active.atReply = createAtReplyReader(active.atLineStart);
      update({ sending: true, testingAt: testAt, monitorMessage: testAt ? '正在等待 AT 响应…' : '正在发送…' });
      await writer.write(bytes);
      if (testAt) {
        if (active.atReply && !active.stopping) {
          active.atTimer = setTimeout(() => finishAt(active,
            '3 秒内未收到 AT 响应。请检查控制台接口、波特率，并确认固件支持通过串口发送 AT 指令。'), 3000);
        }
        return;
      }
      if (!active.stopping) {
        const entry = { command, format, ending };
        setView(old => ({
          ...old,
          monitorMessage: '指令已发送。',
          commandHistory: [...old.commandHistory.filter(item =>
            item.command !== command || item.format !== format ||
            (format === 'text' && item.ending !== ending)), entry].slice(-50),
        }));
      }
    } catch (error) {
      if (!active.stopping) {
        if (testAt) finishAt(active, localizedMessage('AT 发送失败。@0', error));
        else update({ monitorMessage: localizedMessage('发送失败。@0', error) });
      }
    } finally {
      writer?.releaseLock();
      active.writer = null;
      if (monitor.current === active) update({ sending: false });
    }
  }

  async function readMonitor(active) {
    const decoder = new TextDecoder();
    let message = '';
    let received = false;
    try {
      while (!active.stopping) {
        const { done, value } = await active.reader.read();
        if (done) break;
        if (value.length) clearTimeout(active.releaseTimer);
        const output = decoder.decode(value, { stream: true });
        if (value.length) active.atLineStart = value.at(-1) === 10 || value.at(-1) === 13;
        const reply = active.atReply?.(output);
        if (reply === 'Unrecognized command') {
          finishAt(active, '串口收发正常。当前控制台不识别 AT，可发送 help 查看支持的命令。');
        } else if (reply) {
          finishAt(active, reply === 'OK' ? '设备已响应 AT（OK）。' : localizedMessage('设备返回 @0', reply));
        }
        if (output && !received) {
          received = true;
          update({ monitorReceived: true });
        }
        queuePreview(output);
        active.recorder?.append(output);
      }
    } catch (error) {
      if (!active.stopping) message = localizedMessage('串口读取中断。@0', error);
    } finally {
      const requestedStop = active.stopping;
      active.stopping = true;
      const interrupted = Boolean(active.atReply);
      clearTimeout(active.atTimer);
      active.atReply = null;
      update({ canSend: false, testingAt: false, commandHistory: [] });
      const cancelWrite = active.writer?.abort().catch(() => {});
      const tail = decoder.decode();
      queuePreview(tail);
      flushPreview();
      active.recorder?.append(tail);
      const wasRecording = Boolean(active.recorder);
      const saved = stopRecording(active);
      clearTimeout(active.releaseTimer);
      await Promise.all([active.signalTask, cancelWrite]);
      active.reader.releaseLock();
      if (active.port.readable || active.port.writable) {
        try {
          await active.port.close();
        } catch (error) {
          message = localizedMessage('无法释放日志串口。@0', error);
        }
      }
      await saved;
      if (monitor.current === active) {
        monitor.current = null;
        update({
          monitoring: false,
          monitorReceived: false,
          ...(message || interrupted || !requestedStop || !wasRecording ? {
            monitorMessage: message || (interrupted ? '串口已断开，AT 测试中断。' : (requestedStop ? '日志串口已断开。' : '串口已断开。请重新连接。')),
          } : {}),
        });
      }
    }
  }

  async function startMonitor(port, rate, platform) {
    await port.open({ baudRate: Number(rate) });
    let reader;
    try {
      reader = port.readable.getReader();
    } catch (error) {
      await port.close().catch(() => {});
      throw error;
    }
    const active = { port, reader, platform, stopping: false, atLineStart: true };
    preview.current.beginSession();
    monitor.current = active;
    update({
      monitoring: true, monitorReceived: false, monitorMessage: '',
      canSend: Boolean(port.writable), sending: false, commandHistory: [],
    });
    active.done = readMonitor(active);
    if (
      platform === 'bk7258' || platform === 'lierda' ||
      (platform === 'esp32' && isKnownUartBridge(port))
    ) {
      // An already active console can keep its current signal state.
      active.releaseTimer = setTimeout(() => {
        if (active.stopping || monitor.current !== active) return;
        active.signalTask = Promise.resolve()
          .then(() => releaseSerialControlLines(port))
          .catch((error) => {
            if (!active.stopping && monitor.current === active)
              monitorStatus(localizedMessage('无法自动释放 RTS/DTR。@0', error));
          });
      }, serialOutputGraceMs);
    }
  }

  function connectLierda(options, reusePort, chooseOther) {
    if (busy.current || !serial) return;
    const controller = new AbortController();
    const { signal } = controller;
    const { downloadOnly, baudrate = USB_BAUD } = options;
    let openingDownloadPort = false;
    return run(async () => {
      const handoff = chooseOther ? null : pendingLierdaDownload.current;
      let port;
      if (handoff) {
        port = await selectLierdaDownloadPort(serial, handoff);
      } else if (reusePort && (!downloadOnly || isDownloadPort(retryPort.current))) {
        port = retryPort.current;
      } else {
        flashStatus('正在检查已授权的利尔达串口…');
        port = await selectLierdaPort(serial, { downloadOnly, chooseOther });
      }
      if (!port) throw new LocalizedError('请重新选择利尔达串口。');
      if (downloadOnly && (!isDownloadPort(port) || port.connected === false)) {
        throw new LocalizedError('请选择已连接的 Lierda QDLoader 下载口。');
      }
      lierdaConnection.current = controller;
      update({ lierdaConnecting: true });
      if (!handoff) update({ flashLog: '', progress: null, complete: false });
      setTab('flash');
      flashStatus('正在校验利尔达 USB AgentBoot…');
      const agent = await loadLierdaAgentBoot(signal);
      signal.throwIfAborted();
      retryPort.current = isDownloadPort(port) ? port : null;
      pendingLierdaDownload.current = null;
      update({ canReconnect: false, needsLierdaDownloadPort: false });
      await releaseMonitor();
      signal.throwIfAborted();
      if (!isDownloadPort(port)) {
        flashStatus('正在切换到利尔达下载模式…');
        const atPort = port;
        const ports = await waitForSerialOperation(serial.getPorts(), signal);
        const previousPorts = ports.filter((candidate) => candidate.connected !== false);
        const transition = { atPort, previousPorts };
        const waiting = new AbortController();
        const atFinished = deferredSerialResult();
        let downloadPort;
        try {
          await requestLierdaDownloadMode(atPort, {
            signal,
            log: line => appendLog('flashLog', line + '\n'),
            onDownloadRequested() { pendingLierdaDownload.current = transition; },
            onDownloadSent() {
              flashStatus('正在等待利尔达下载口。首次使用可点击「选择下载口」。');
              downloadPort = chooseLierdaDownloadPort(serial, transition, {
                signal: AbortSignal.any([signal, waiting.signal]),
                pollAfter: atFinished.promise,
                offerManualChoice(choosePort) {
                  manualLierdaDownload.current = choosePort;
                  update({ needsLierdaDownloadPort: true });
                },
              });
              // A chooser can finish while the AT command is still waiting for its reply.
              downloadPort.catch(() => {});
            },
            onDownloadRejected() { pendingLierdaDownload.current = null; },
          });
          atFinished.resolve();
          port = await downloadPort;
        } finally {
          waiting.abort();
          manualLierdaDownload.current = null;
        }
        if (!port) {
          update({ needsLierdaDownloadPort: true });
          flashStatus('尚未接入下载口。请授权 Lierda QDLoader Port。');
          return;
        }
        pendingLierdaDownload.current = null;
        update({ needsLierdaDownloadPort: false });
      }
      flashStatus('正在识别利尔达设备…');
      retryPort.current = port;
      openingDownloadPort = true;
      appendLog('flashLog', t('正在连接 QDLoader · @0 波特\n', baudrate));
      const { connectLierda: connectDevice } = await import('./lierda.mjs');
      const session = await connectDevice(port, { ...options, agent, signal }, line => appendLog('flashLog', line));
      if (signal.aborted) {
        await session.close().catch(() => {});
        signal.throwIfAborted();
      }
      flash.current = { port, session, platform: 'lierda', abort: new AbortController() };
      retryPort.current = null;
      lierdaBackup.current = null;
      update({ device: session, canReconnect: false, flashBackup: null });
      if (session.lierdaCompatibilityIssue) {
        flashStatus('已连接 · 利尔达下载口');
      } else {
        const model = session.lierdaModel === 'pro-f9' ? 'NT26F9D0' : 'NT26F6D0';
        flashStatus(localizedMessage('已连接 · @0 · @1 · Flash @2', model, session.chip, session.capacityLabel));
      }
    }, (message, error) => {
      if (!signal.aborted && error.name === 'NotFoundError') {
        flashStatus(pendingLierdaDownload.current
          ? '未选择下载口。可点击「选择下载口」继续。'
          : '未选择串口。可重新连接并选择利尔达设备。');
        return;
      }
      if (retryPort.current?.connected === false) retryPort.current = null;
      update({
        canReconnect: Boolean(retryPort.current),
        needsLierdaDownloadPort: Boolean(pendingLierdaDownload.current),
      });
      if (signal.aborted) {
        flashStatus('已取消连接。');
        appendLog('flashLog', t('已取消连接。') + '\n');
        return;
      }
      const status = openingDownloadPort && baudrate !== USB_BAUD
        ? localizedMessage('@0 可在高级设置恢复默认 @1 波特后重试。', message, USB_BAUD)
        : message;
      appendLog('flashLog', t(status) + '\n');
      flashStatus(status, true);
    }).finally(() => {
      lierdaConnection.current = null;
      update({ lierdaConnecting: false });
    });
  }

  function cancelLierdaConnection() {
    const controller = lierdaConnection.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    flashStatus('正在取消连接…');
    update({ lierdaConnecting: false });
  }

  function connect(options, reusePort = false, chooseOther = false) {
    if (options.platform === 'lierda') return connectLierda(options, reusePort, chooseOther);
    return run(
      async () => {
        // Keep the serial chooser inside the initiating click gesture.
        const port = reusePort
          ? retryPort.current
          : await serial.requestPort();
        if (!port) throw new LocalizedError('请重新选择烧录串口。');
        retryPort.current = port;
        await releaseMonitor();
        update({ flashLog: '', progress: null, complete: false });
        const bk = options.platform === 'bk7258';
        flashStatus(
          bk
            ? '正在打开所选串口，请留意烧录日志中的握手提示。'
            : '正在连接并识别 ESP32…',
        );
        if (bk) setTab('flash');
        const connectDevice = bk
          ? (await import('./bk7258.mjs')).connectBk7258
          : (await import('./esp32.mjs')).connectEsp32;
        const session = await connectDevice(port, options, (line) =>
          appendLog('flashLog', line),
        );
        flash.current = {
          port,
          session,
          platform: options.platform,
          abort: new AbortController(),
        };
        retryPort.current = null;
        update({ device: session, canReconnect: false });
        flashStatus(
          localizedMessage('已连接 · @0 · Flash @1', session.chip, session.capacityLabel),
        );
      },
      (message, error) => {
        flashStatus(message, error.name !== 'NotFoundError');
        if (error.name !== 'NotFoundError') {
          update({ canReconnect: Boolean(retryPort.current) });
          appendLog('flashLog', t(message) + '\n');
          setTab('flash');
        }
      },
    );
  }

  function disconnect() {
    return run(
      async () => {
        await releaseFlash();
        flashStatus('已断开烧录串口。');
      },
      (message) => flashStatus(message, true),
    );
  }

  function toggleMonitor(rate, platform) {
    return run(async () => {
      if (monitor.current) {
        await releaseMonitor();
        return;
      }
      const port = await serial.requestPort();
      if (platform === 'lierda' && isDownloadPort(port)) {
        throw new LocalizedError('请选择运行中的 Lierda At Port。');
      }
      if (flash.current?.port === port) {
        await releaseFlash();
        flashStatus('已释放烧录串口。若设备停在下载模式，请手动复位。');
      }
      await startMonitor(port, rate, platform);
    }, monitorStatus);
  }

  function showDeviceLog(rate, platform) {
    setTab('log');
    if (platform === 'lierda') {
      if (!monitor.current) return toggleMonitor(rate, platform);
      return;
    }
    const port = lastFlashedPort.current;
    if (!port || monitor.current?.port === port) return;
    if (flash.current?.port === port) {
      monitorStatus('请先断开烧录串口，再连接到设备日志。');
      return;
    }
    return run(
      async () => {
        await releaseMonitor();
        await startMonitor(port, rate, platform);
      },
      (message) => monitorStatus(message),
    );
  }

  function writeLierda(firmware, restart) {
    const active = flash.current;
    if (active?.platform !== 'lierda' || firmware.targetDevice !== active.session) {
      flashStatus('烧录设备已变化，请重新检查设备并确认烧录。', true);
      return;
    }
    const { session, abort } = active;
    if (session.lierdaModel !== firmware.model || session.chip !== firmware.chip
        || session.capacity !== firmware.flashBytes) {
      flashStatus('设备型号、芯片或 Flash 布局与所选固件不匹配。', true);
      return;
    }
    return run(async () => {
      let percent = 0;
      update({ tab: 'flash', complete: false });
      progress('准备固件', 0);
      try {
        const input = firmware.input;
        abort.signal.throwIfAborted();
        appendLog('flashLog', t('选定固件：@0\n', input.filename));
        await releaseMonitor();
        abort.signal.throwIfAborted();
        await session.writeLierda(input, {
          allowReinstall: firmware.writePlan.mode === 'reinstall',
          onProgress(fraction, message) {
            percent = Math.min(99, Math.max(percent, Math.round(99 * fraction)));
            progress(message, percent);
          },
          log: line => appendLog('flashLog', line + '\n'),
          async saveBackup(bytes, digest) {
            const backup = await persistLierdaFlashBackup(bytes, digest, firmware.model);
            lierdaBackup.current = backup;
            update({ flashBackup: backup.name });
            return backup.location;
          },
        });
        abort.signal.throwIfAborted();
      } catch (error) {
        const failure = abort.signal.reason ?? error;
        progress('烧录未完成', percent, 'failed');
        appendLog('flashLog', failure.message + '\n');
        if (flash.current === active && !session.canRetry) await releaseFlash().catch(() => {});
        throw failure;
      }
      progress('烧录完成，校验通过', 100, 'success');
      let completionMessage = '写入并校验完成。已停留在下载模式，请按 RESET 启动固件。';
      try {
        if (restart) {
          active.resetting = true;
          await session.reset();
          completionMessage = '写入并校验完成。设备已复位。';
          update({ complete: firmware.writePlan.mode !== 'app' });
        }
      } catch (error) {
        appendLog('flashLog', t('自动复位失败：@0\n', error.message));
        completionMessage = '写入并校验完成。请按板上的复位键启动固件。';
      } finally {
        await releaseFlash().catch(error => appendLog('flashLog', t('释放串口失败：@0\n', error.message)));
      }
      appendLog('flashLog', t(completionMessage) + '\n');
      flashStatus(completionMessage);
    }, message => flashStatus(message, true));
  }

  async function downloadFlashBackup() {
    const backup = lierdaBackup.current;
    if (!backup) return;
    try {
      const file = await backup.handle.getFile();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = backup.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      flashStatus(localizedMessage('无法导出备份。@0', error), true);
    }
  }

  function write(firmware, options) {
    if (firmware.kind === 'lierda') return writeLierda(firmware, options?.restart ?? true);
    if (!flash.current) {
      flashStatus('烧录串口已断开，请重新连接。', true);
      return;
    }
    return run(
      async () => {
        const active = flash.current;
        const { port, session, abort } = active;
        const complete = firmware.kind !== 'segments';
        update({ tab: 'flash', complete: false });
        progress(
          firmware.kind === 'official' ? '下载并核对固件' : '准备固件',
          0,
        );
        let written = 0;
        let writeStarted = false;
        try {
          abort.signal.throwIfAborted();
          const images =
            firmware.kind === 'official'
              ? [
                  await downloadFirmware(
                    firmware.release,
                    session.capacity,
                    abort.signal,
                  ),
                ]
              : await Promise.all(
                  firmware.entries.map(async ({ file, ...entry }) => ({
                    ...entry,
                    data: new Uint8Array(await file.arrayBuffer()),
                  })),
                );
          abort.signal.throwIfAborted();
          const label =
            firmware.kind === 'official'
              ? releaseLabel(firmware.release.version) +
                (firmware.release.embedded_version
                  ? t('（固件内置版本 @0）', firmware.release.embedded_version)
                  : '')
              : firmware.entries.map(({ name }) => name).join(t('、'));
          appendLog('flashLog', t('选定固件：@0\n', label));
          await releaseMonitor();
          abort.signal.throwIfAborted();
          progress('固件已就绪，正在准备擦写', 0);
          writeStarted = true;
          await session.write(
            images,
            { ...options.flash, complete },
            (fraction) => {
              written = Math.min(
                99,
                Math.max(written, Math.round(99 * fraction)),
              );
              progress(
                fraction >= 1 ? '正在校验写入内容' : '正在写入固件',
                written,
              );
            },
          );
          abort.signal.throwIfAborted();
        } catch (error) {
          const failure = abort.signal.reason ?? error;
          progress(writeStarted ? '烧录失败' : '固件准备中断', written, 'failed');
          setTab('flash');
          appendLog('flashLog', '\n' + failure.message + '\n');
          if (!writeStarted && flash.current === active && !abort.signal.aborted) {
            appendLog('flashLog', t('尚未开始擦写，串口仍已连接。可重新选择固件或再次开始烧录。\n'));
            return;
          }
          if (flash.current === active) {
            retryPort.current = port;
            update({ canReconnect: true });
          }
          await releaseFlash().catch((closeError) => {
            appendLog('flashLog', t('释放串口失败：') + closeError.message + '\n');
          });
          throw failure;
        }

        progress('烧录完成，校验通过', 100, 'success');
        lastFlashedPort.current = port;
        update({ complete });
        let resetFailed = false;
        let resetStatus;
        try {
          if (options.restart) resetStatus = await session.reset();
        } catch (error) {
          resetFailed = true;
          appendLog('flashLog', t('自动复位失败：@0', error) + '\n');
        } finally {
          try {
            await releaseFlash();
          } catch (error) {
            resetFailed = true;
            appendLog('flashLog', t('释放串口失败：@0', error) + '\n');
          }
        }
        flashStatus(
          !options.restart || resetFailed
            ? '写入并校验完成。请按板上的复位键启动固件。'
            : typeof resetStatus === 'string'
              ? localizedMessage('写入并校验完成。@0', localizedMessage(resetStatus))
              : '写入并校验完成。设备已复位。',
        );
        if (options.restart && options.autoLog && !resetFailed) {
          setTab('log');
          try {
            await startMonitor(port, options.logRate, active.platform);
          } catch (error) {
            monitorStatus(localizedMessage('无法自动打开日志串口。@0', error));
          }
        }
      },
      (message) => flashStatus(message, true),
    );
  }

  useEffect(() => {
    const detached = (event) => {
      if (
        retryPort.current &&
        (event.port === retryPort.current || event.target === retryPort.current)
      ) {
        retryPort.current = null;
        update({ canReconnect: false });
      }
      if (
        flash.current &&
        (event.port === flash.current.port ||
          event.target === flash.current.port)
      ) {
        const active = flash.current;
        if (active.platform === 'lierda' && active.resetting) return;
        flash.current = null;
        const error = new LocalizedError('设备串口已断开，请重新连接。');
        active.abort.abort(error);
        active.session.close().catch(() => {});
        update({
          device: null,
          deviceMessage: error,
          deviceError: true,
        });
      }
    };
    serial?.addEventListener('disconnect', detached);
    return () => serial?.removeEventListener('disconnect', detached);
  }, []);

  return {
    ...view,
    deviceMessage: t(view.deviceMessage),
    monitorMessage: t(view.monitorMessage),
    serialAvailable: Boolean(serial),
    monitorStatus,
    connect,
    chooseLierdaDownloadPort: () => manualLierdaDownload.current?.(),
    cancelLierdaConnection,
    disconnect,
    write,
    downloadFlashBackup,
    toggleMonitor,
    toggleRecording,
    sendCommand,
    testAt: () => sendCommand('AT', 'text', '\r', true),
    setTab,
    showDeviceLog,
    resetForPlatform: () => {
      lastFlashedPort.current = null;
      retryPort.current = null;
      pendingLierdaDownload.current = null;
      update({
        canReconnect: false,
        needsLierdaDownloadPort: false,
        complete: false,
        progress: null,
        flashLog: '',
        monitorMessage: '',
      });
      flashStatus(initialState.deviceMessage);
    },
    clearLog: () => {
      preview.current = createSerialPreview(logLimit);
      flushPreview();
    },
  };
}
