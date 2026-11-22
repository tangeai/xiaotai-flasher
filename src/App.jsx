import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadBoards } from './catalog.mjs';
import { prepareFirmware } from './firmware.mjs';
import { settingFields } from './settings.mjs';
import { useWorkbench } from './useWorkbench.js';

const logRates = ['115200', '9600', '57600', '230400', '460800', '921600'];
const defaultSettings = Object.fromEntries(
  settingFields.map(([key, , options]) => [key, options[0][0]]),
);
const recommendedVersion = (board) =>
  board?.versions.find((version) => version.recommended)?.version ??
  board?.versions[0]?.version ??
  '';
const platformFor = (chip) => (chip === 'BK7258' ? 'bk7258' : 'esp32');
let nextSegmentId = 0;
const newSegment = () => ({ id: nextSegmentId++, file: null, offset: '' });

function Check({ children, help, ...props }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>
        {children}
        {help && <small>{help}</small>}
      </span>
    </label>
  );
}

function FlashOptions({ settings, change, disabled, official, connected, bk }) {
  const fields = bk
    ? settingFields.filter(([key]) => key === 'after-reset')
    : settingFields;
  return (
    <details className="settings-group" id="advanced">
      <summary>高级设置</summary>
      <div className="options">
        {fields.map(([key, label, options, help]) => (
          <label className="field" key={key}>
            {label}
            <select
              id={key}
              value={settings[key]}
              onChange={(event) => change(key, event.target.value)}
              disabled={
                disabled ||
                (official && key === 'expected-chip') ||
                (connected && ['before-reset', 'write-rate'].includes(key))
              }
            >
              {options.map(([value, title]) => (
                <option key={value} value={value}>
                  {title ?? value}
                </option>
              ))}
            </select>
            <small>{help}</small>
          </label>
        ))}
        {bk ? (
          <small className="span">
            烧录通过 UART0，固定 115200 波特率。连接时按提示复位设备。
          </small>
        ) : (
          <>
            <Check
              checked={settings.compress}
              disabled={disabled}
              onChange={(event) => change('compress', event.target.checked)}
              help="压缩串口传输的数据，写入 Flash 的内容保持原样。"
            >
              压缩传输
            </Check>
            <details className="span">
              <summary>擦除选项</summary>
              <Check
                checked={settings.eraseAll}
                disabled={disabled}
                onChange={(event) => change('eraseAll', event.target.checked)}
                help="写入前擦除整片 Flash。默认只擦除镜像覆盖的扇区。"
              >
                全片擦除
              </Check>
            </details>
            <small className="span">
              写入后始终校验。模式、频率和容量覆写只用于对应芯片的启动镜像位置。
            </small>
          </>
        )}
      </div>
    </details>
  );
}

function FirmwarePicker({
  catalog,
  origin,
  choose,
  selection,
  change,
  busy,
  bk,
}) {
  const board = catalog.boards.find(
    (candidate) => candidate.slug === selection.slug,
  );
  function changeSegment(id, patch) {
    change({
      segments: selection.segments.map((segment) =>
        segment.id === id ? { ...segment, ...patch } : segment,
      ),
    });
  }

  return (
    <>
      <h2 id="firmware-title">选择固件</h2>
      <div className="choices row" role="group" aria-label="选择固件来源">
        <label>
          <input
            type="radio"
            name="source"
            value="official"
            checked={origin === 'official'}
            disabled={busy || !catalog.boards.length}
            onChange={() => choose('official')}
          />{' '}
          小钛固件
        </label>
        <label>
          <input
            type="radio"
            name="source"
            value="local"
            checked={origin === 'local'}
            disabled={busy}
            onChange={() => choose('local')}
          />{' '}
          本地 BIN
        </label>
      </div>
      <small id="catalog-status" role="status">
        {catalog.message}
      </small>
      <div id="official" className="options" hidden={origin !== 'official'}>
        <label className="field">
          开发板
          <select
            id="board"
            value={selection.slug}
            disabled={busy}
            onChange={(event) => {
              const next = catalog.boards.find(
                (candidate) => candidate.slug === event.target.value,
              );
              change({
                slug: event.target.value,
                version: recommendedVersion(next),
              });
            }}
          >
            {catalog.boards.map(({ slug, model }) => (
              <option key={slug} value={slug}>
                {model}
              </option>
            ))}
          </select>
          <small>按完整板卡型号选择固件。</small>
        </label>
        <label className="field">
          固件版本
          <select
            id="version"
            value={selection.version}
            disabled={busy}
            onChange={(event) => change({ version: event.target.value })}
          >
            {board?.versions.map(({ version, recommended }) => (
              <option key={version} value={version}>
                {version}
                {recommended ? '（推荐）' : ''}
              </option>
            ))}
          </select>
          <small>选择要写入的已发布版本。</small>
        </label>
        {board && (
          <p className="callout span" id="manifest">
            {board.chip} · 完整镜像 · 起始地址 0x0
          </p>
        )}
      </div>
      <div hidden={origin !== 'local'}>
        <label className="field" hidden={!bk && selection.segmented}>
          完整镜像 · 起始地址 <code>0x0</code>
          <input
            type="file"
            id="merged-bin"
            accept=".bin"
            disabled={busy}
            onChange={(event) => change({ merged: event.target.files[0] })}
          />
          <small>
            {bk
              ? '选择适配开发板的 BK7258 原始 all-app.bin。'
              : '选择适配开发板的完整 BIN。'}
          </small>
        </label>
        <details className="settings-group" id="segments" hidden={bk}>
          <summary>分段烧录</summary>
          <Check
            checked={selection.segmented}
            disabled={busy}
            onChange={(event) => change({ segmented: event.target.checked })}
            help="对照固件说明填写每个 BIN 的起始地址。"
          >
            使用分段固件
          </Check>
          <div hidden={!selection.segmented}>
            {selection.segments.map(({ id, offset }) => (
              <div className="firmware-row" key={id}>
                <label className="field">
                  固件文件
                  <input
                    type="file"
                    accept=".bin"
                    disabled={busy}
                    onChange={(event) =>
                      changeSegment(id, { file: event.target.files[0] })
                    }
                  />
                  <small>要写入的二进制镜像。</small>
                </label>
                <label className="field">
                  起始地址
                  <input
                    type="text"
                    value={offset}
                    placeholder="0x10000"
                    disabled={busy}
                    onChange={(event) =>
                      changeSegment(id, { offset: event.target.value })
                    }
                  />
                  <small>该 BIN 在 Flash 的偏移。</small>
                </label>
                <button
                  className="btn remove"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    change({
                      segments: selection.segments.filter(
                        (entry) => entry.id !== id,
                      ),
                    })
                  }
                >
                  移除
                </button>
              </div>
            ))}
            <button
              className="btn actions"
              type="button"
              disabled={busy}
              onClick={() =>
                change({ segments: [...selection.segments, newSegment()] })
              }
            >
              添加 BIN
            </button>
          </div>
        </details>
      </div>
    </>
  );
}

function LogConsole({ workbench, rate, setRate }) {
  const {
    tab,
    busy,
    monitoring,
    monitorMessage,
    bootLog,
    flashLog,
    progress,
    complete,
    serialAvailable,
  } = workbench;
  const flashTab = tab === 'flash';
  const [paused, setPaused] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const deviceOutput = useRef(null);
  const flashOutput = useRef(null);
  const deviceTab = useRef(null);
  const processTab = useRef(null);
  useLayoutEffect(() => {
    if (!flashTab && !paused)
      deviceOutput.current.scrollTop = deviceOutput.current.scrollHeight;
  }, [bootLog, flashTab, paused]);
  useLayoutEffect(() => {
    if (flashTab)
      flashOutput.current.scrollTop = flashOutput.current.scrollHeight;
  }, [flashLog, flashTab]);

  function changeWithKeyboard(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'log'
        : event.key === 'End'
          ? 'flash'
          : flashTab
            ? 'log'
            : 'flash';
    workbench.setTab(next);
    (next === 'log' ? deviceTab : processTab).current.focus();
  }

  async function copyLog(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('已复制日志。');
    } catch {
      setCopyStatus('复制失败。可选中日志后手动复制。');
    }
  }

  function downloadLog() {
    const url = URL.createObjectURL(
      new Blob([bootLog], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'xiaotai-serial.log';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const taskStatus =
    { writing: '烧录中', success: '校验通过', failed: '烧录失败' }[
      progress?.outcome
    ] || '等待烧录';
  return (
    <section className="console" aria-label="日志">
      <div className="console-head row spread">
        <div
          className="tabs"
          role="tablist"
          aria-label="日志类型"
          onKeyDown={changeWithKeyboard}
        >
          <button
            ref={deviceTab}
            id="log-tab"
            role="tab"
            aria-selected={!flashTab}
            aria-controls="device-log"
            type="button"
            tabIndex={flashTab ? -1 : 0}
            onClick={() => workbench.setTab('log')}
          >
            串口日志
          </button>
          <button
            ref={processTab}
            id="flash-tab"
            role="tab"
            aria-selected={flashTab}
            aria-controls="flash-log"
            type="button"
            tabIndex={flashTab ? 0 : -1}
            onClick={() => workbench.setTab('flash')}
          >
            烧录过程
          </button>
        </div>
        <span className="console-status" role="status">
          {flashTab ? taskStatus : monitoring ? '正在接收' : '未连接'}
        </span>
      </div>
      <div
        className="console-pane"
        id="device-log"
        role="tabpanel"
        aria-labelledby="log-tab"
        hidden={flashTab}
      >
        <div className="row spread log-controls">
          <button
            className="btn primary"
            type="button"
            disabled={!serialAvailable || busy}
            onClick={() => workbench.toggleMonitor(rate)}
          >
            {monitoring ? '断开日志串口' : '连接日志串口'}
          </button>
          <label className="row">
            日志波特率
            <select
              value={rate}
              onChange={(event) => setRate(event.target.value)}
              disabled={monitoring || busy}
              aria-describedby="log-rate-help"
            >
              {logRates.map((baud) => (
                <option key={baud}>{baud}</option>
              ))}
            </select>
          </label>
          <small className="sr-only" id="log-rate-help">
            UART 读取速率需与固件控制台配置一致。原生 USB 日志请按板卡说明连接。
          </small>
        </div>
        <pre
          ref={deviceOutput}
          id="monitor-output"
          aria-label="设备日志输出"
          tabIndex={0}
        >
          {bootLog || (monitoring ? '等待设备日志…' : '连接后显示设备日志。')}
        </pre>
        <div className="row log-actions">
          <button
            className="btn"
            type="button"
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? '恢复滚动' : '暂停滚动'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={workbench.clearLog}
          >
            清空
          </button>
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={() => copyLog(bootLog)}
          >
            复制
          </button>
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={downloadLog}
          >
            下载日志
          </button>
        </div>
        <small role="status">{monitorMessage}</small>
        {complete && (
          <p id="monitor-setup" className="callout">
            完整镜像已写入。请重新配置设备 Wi‑Fi，再到
            <a href="https://xiaotai.chat/devices">设备管理</a>绑定。
          </p>
        )}
      </div>
      <div
        className="console-pane"
        id="flash-log"
        role="tabpanel"
        aria-labelledby="flash-tab"
        hidden={!flashTab}
      >
        <pre
          ref={flashOutput}
          id="flash-output"
          aria-label="烧录过程输出"
          tabIndex={0}
        >
          {flashLog || '等待开始烧录。'}
        </pre>
        <div className="row log-actions">
          <button
            className="btn"
            type="button"
            disabled={!flashLog}
            onClick={() => copyLog(flashLog)}
          >
            复制烧录日志
          </button>
        </div>
      </div>
      <small role="status">{copyStatus}</small>
    </section>
  );
}

function FlashSummary({ firmware, chip }) {
  const official = firmware.kind === 'official';
  const segmented = firmware.kind === 'segments';
  const address = official ? 0 : firmware.entries[0].address;

  return (
    <dl className="flash-summary">
      <div>
        <dt>目标芯片</dt>
        <dd>{chip ?? '设备已断开'}</dd>
      </div>
      {official && (
        <>
          <div>
            <dt>开发板</dt>
            <dd>{firmware.boardModel}</dd>
          </div>
          <div>
            <dt>固件版本</dt>
            <dd>{firmware.release.version}</dd>
          </div>
        </>
      )}
      <div>
        <dt>烧录方式</dt>
        <dd>{segmented ? '分段烧录' : '完整镜像'}</dd>
      </div>
      {segmented ? (
        <div>
          <dt>文件及地址</dt>
          <dd>
            <ul className="flash-summary-files">
              {firmware.entries.map(({ name, address }) => (
                <li key={address}>
                  <span>{name}</span>
                  <code>0x{address.toString(16)}</code>
                </li>
              ))}
            </ul>
            <small>各地址是相对 Flash 起始位置的字节偏移。</small>
          </dd>
        </div>
      ) : (
        <>
          {!official && (
            <div>
              <dt>BIN 文件</dt>
              <dd>{firmware.entries[0].name}</dd>
            </div>
          )}
          <div>
            <dt>烧录起始地址</dt>
            <dd>
              <code>0x{address.toString(16)}</code>
              <small>从 Flash 起始位置写入，偏移 0 字节。</small>
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

function HelpDialog({ dialogRef, onClose }) {
  return (
    <dialog
      id="troubleshooting"
      ref={dialogRef}
      aria-labelledby="help-title"
      onClose={onClose}
    >
      <div className="row spread">
        <h2 id="help-title">连接与排查</h2>
        <form method="dialog">
          <button className="btn" type="submit">
            关闭
          </button>
        </form>
      </div>
      <p className="actions">
        用桌面 Chrome 或 Edge 在 HTTPS 页面打开工作台，并使用支持数据传输的 USB
        线。
      </p>
      <details className="settings-group">
        <summary>找不到串口</summary>
        <p>检查数据线和 USB 串口驱动。关闭占用串口的其他工具，再连接设备。</p>
      </details>
      <details className="settings-group">
        <summary>无法进入下载模式</summary>
        <p>
          ESP32 按板卡指南操作 BOOT / RESET
          键，再使用高级设置里的「手动进入下载模式」。写入不稳定时可把烧录波特率降到
          115200。
        </p>
        <p className="actions">
          BK7258 使用下载串口
          UART0。点击「连接设备」后，按复位键或保持串口连接并重新给开发板上电，等待握手。
        </p>
      </details>
      <details className="settings-group">
        <summary>看不到设备日志</summary>
        <p>
          确认固件的日志输出接口和波特率。若重启后设备的串口变化，请重新选择日志串口。
          BK7258 的 UART0 日志默认使用 115200 波特率。
        </p>
      </details>
      <details className="settings-group">
        <summary>乐鑫参数文档</summary>
        <p>
          <a href="https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/basic-commands.html">
            烧录参数
          </a>{' '}
          ·{' '}
          <a href="https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/flash-modes.html">
            Flash 配置
          </a>{' '}
          ·{' '}
          <a href="https://docs.espressif.com/projects/esptool/en/latest/esp32/esptool/advanced-options.html">
            复位配置
          </a>{' '}
          ·{' '}
          <a href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/kconfig-reference.html#config-esp-console-uart-baudrate">
            UART 日志设置
          </a>
        </p>
      </details>
    </dialog>
  );
}

export function App() {
  const workbench = useWorkbench();
  const [catalog, setCatalog] = useState({
    boards: [],
    message: '正在读取固件目录…',
  });
  const [origin, setOrigin] = useState('local');
  const [platform, setPlatform] = useState('esp32');
  const [selection, setSelection] = useState(() => ({
    slug: '',
    version: '',
    merged: null,
    segmented: false,
    segments: [newSegment()],
  }));
  const [settings, setSettings] = useState({
    ...defaultSettings,
    compress: true,
    eraseAll: false,
    autoLog: true,
  });
  const [rate, setRate] = useState(logRates[0]);
  const [pending, setPending] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const userSelected = useRef(false);
  const confirmDialog = useRef(null);
  const helpDialog = useRef(null);
  const {
    busy,
    device,
    deviceMessage,
    deviceError,
    progress,
    complete,
    serialAvailable,
  } = workbench;

  useEffect(() => {
    const abort = new AbortController();
    const requested = new URL(location.href).searchParams.get('board');
    const configURL = new URL('boards-source.json', document.baseURI);
    loadBoards(configURL, abort.signal)
      .then((boards) => {
        if (abort.signal.aborted) return;
        const requestedBoard = boards.find((board) => board.slug === requested);
        const board = requestedBoard ?? boards[0];
        setCatalog({
          boards,
          message:
            requested && !requestedBoard
              ? '这块开发板暂无已发布的在线固件，可导入本地 BIN。'
              : boards.length
                ? ''
                : '暂无已发布的小钛固件，可导入本地 BIN。',
        });
        if (board && !userSelected.current) {
          setPlatform(platformFor(board.chip));
          setSelection((old) => ({
            ...old,
            slug: board.slug,
            version: recommendedVersion(board),
          }));
          if (!requested || requestedBoard) setOrigin('official');
        }
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        console.error('Firmware catalog:', error);
        setCatalog({
          boards: [],
          message: '在线固件目录暂不可用，可导入本地 BIN。',
        });
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    if (location.hash === '#troubleshooting') {
      helpDialog.current.showModal();
      setHelpOpen(true);
    }
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  useEffect(() => {
    if (pending && !confirmDialog.current.open) {
      confirmDialog.current.returnValue = 'cancel';
      confirmDialog.current.showModal();
    }
  }, [pending]);

  function changeSelection(patch) {
    userSelected.current = true;
    setSelection((old) => ({ ...old, ...patch }));
  }

  function changeSetting(key, value) {
    setSettings((old) => ({ ...old, [key]: value }));
  }

  const bk = platform === 'bk7258';
  const platformBoards = catalog.boards.filter(
    (board) => platformFor(board.chip) === platform,
  );
  const board =
    platformBoards.find(({ slug }) => slug === selection.slug) ??
    platformBoards[0];
  const selected = {
    ...selection,
    slug: board?.slug ?? '',
    version: board?.versions.some(
      ({ version }) => version === selection.version,
    )
      ? selection.version
      : recommendedVersion(board),
  };

  function changePlatform(value) {
    userSelected.current = true;
    setPlatform(value);
    if (!catalog.boards.some((board) => platformFor(board.chip) === value))
      setOrigin('local');
  }

  let ready;
  let readinessMessage;
  if (!serialAvailable)
    readinessMessage = '请在桌面 Chrome 或 Edge 中打开 HTTPS 烧录页。';
  else {
    try {
      const firmware = prepareFirmware(
        {
          ...selected,
          board,
          origin,
          segmented: !bk && selected.segmented,
          expectedChip: bk ? 'BK7258' : settings['expected-chip'],
        },
        device?.capacity,
      );
      if (!device) readinessMessage = '连接开发板后即可开始烧录。';
      else if (firmware.chip !== 'auto' && firmware.chip !== device.chip) {
        readinessMessage = `固件需要 ${firmware.chip}，当前设备为 ${device.chip}。`;
      } else if (
        firmware.flashBytes &&
        firmware.flashBytes !== device.capacity
      ) {
        readinessMessage = `固件需要 ${firmware.flashBytes / 1048576} MiB Flash，当前设备为 ${device.capacity / 1048576} MiB。`;
      } else {
        ready = firmware;
        readinessMessage =
          firmware.kind === 'segments'
            ? '固件和串口已就绪。'
            : '完整镜像将从 0x0 写入。';
      }
    } catch (error) {
      readinessMessage = error.message;
    }
  }

  function beginWrite(event) {
    const confirm = event.currentTarget.returnValue === 'flash';
    const firmware = pending;
    setPending(null);
    if (!confirm || !firmware) return;
    workbench.write(firmware, {
      restart: settings['after-reset'] === 'reset',
      autoLog: settings.autoLog,
      logRate: rate,
      flash: {
        flashMode: settings['flash-mode'],
        flashFreq: settings['flash-freq'],
        flashSize: settings['flash-size'],
        eraseAll: !bk && settings.eraseAll,
        compress: settings.compress,
      },
    });
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else
        await document.documentElement.requestFullscreen({
          navigationUI: 'hide',
        });
      setFullscreenError('');
    } catch {
      setFullscreenError('当前浏览器窗口无法切换全屏。');
    }
  }

  const completed = progress?.outcome === 'success';
  return (
    <>
      <header className="app-header">
        <a className="brand" href="https://xiaotai.chat/" aria-label="小钛官网">
          <span className="brand-mark" aria-hidden="true">
            钛
          </span>
          <span className="brand-name">小钛</span>
        </a>
        <div className="app-title">
          <h1>ESP32 / BK7258 在线烧录与串口日志</h1>
          <p className="muted">
            适用芯片：ESP32、S2、S3、C2、C3、C5、C6、H2、P4、BK7258
          </p>
        </div>
        <nav className="header-actions" aria-label="工作台工具">
          <button
            className="btn subtle"
            type="button"
            aria-controls="troubleshooting"
            aria-expanded={helpOpen}
            onClick={() => {
              helpDialog.current.showModal();
              setHelpOpen(true);
            }}
          >
            连接与排查
          </button>
          {document.fullscreenEnabled && (
            <button className="btn" type="button" onClick={toggleFullscreen}>
              {fullscreen ? '退出全屏' : '全屏'}
            </button>
          )}
        </nav>
      </header>
      <main className="app">
        {!serialAvailable && (
          <p className="callout" role="status">
            当前环境无法访问串口，请使用桌面 Chrome 或 Edge 打开 HTTPS 烧录页。
          </p>
        )}
        <section className="device-bar row" aria-label="烧录设备连接">
          <h2>烧录设备</h2>
          <label className="row">
            芯片平台
            <select
              value={platform}
              disabled={busy || Boolean(device)}
              onChange={(event) => changePlatform(event.target.value)}
            >
              <option value="esp32">ESP32 系列</option>
              <option value="bk7258">BK7258</option>
            </select>
          </label>
          <p
            className={`device-status ${deviceError ? 'error' : 'muted'}`}
            role="status"
          >
            {deviceMessage}
          </p>
          {device ? (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={workbench.disconnect}
            >
              断开连接
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={busy || !serialAvailable}
              onClick={() => {
                userSelected.current = true;
                workbench.connect({
                  platform,
                  baudrate: Number(settings['write-rate']),
                  before: settings['before-reset'],
                });
              }}
            >
              连接设备
            </button>
          )}
        </section>
        <div className="workbench">
          <section className="flash-panel" aria-labelledby="firmware-title">
            <div className="flash-settings">
              <FirmwarePicker
                catalog={{ ...catalog, boards: platformBoards }}
                origin={origin}
                choose={(value) => {
                  userSelected.current = true;
                  setOrigin(value);
                }}
                selection={selected}
                change={changeSelection}
                busy={busy}
                bk={bk}
              />
              <FlashOptions
                settings={settings}
                change={changeSetting}
                disabled={busy}
                official={origin === 'official'}
                connected={Boolean(device)}
                bk={bk}
              />
              {completed && (
                <div className="actions">
                  {complete && (
                    <p className="callout">
                      完整镜像已写入。请重新配网和绑定设备。
                    </p>
                  )}
                  <div className="row actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => workbench.showDeviceLog(rate)}
                    >
                      查看设备日志
                    </button>
                    <a href="https://xiaotai.chat/devices">前往设备管理</a>
                  </div>
                </div>
              )}
            </div>
            <section className="launch" aria-label="执行烧录">
              <div className="row spread">
                <p className="muted" id="start-hint" aria-live="polite">
                  {busy ? '正在处理，请保持 USB 连接。' : readinessMessage}
                </p>
                <button
                  className="btn primary"
                  id="start"
                  type="button"
                  aria-describedby="start-hint"
                  disabled={busy || !ready}
                  onClick={() => setPending(ready)}
                >
                  {busy && progress?.outcome === 'writing'
                    ? '烧录中…'
                    : '开始烧录'}
                </button>
              </div>
              <div className="actions">
                <Check
                  checked={settings.autoLog}
                  disabled={busy || settings['after-reset'] === 'stay'}
                  onChange={(event) =>
                    changeSetting('autoLog', event.target.checked)
                  }
                  help="重启后尝试用已授权的串口读取运行输出。"
                >
                  烧录完成后打开串口日志
                </Check>
              </div>
              {progress && (
                <div className="actions">
                  <div className="row spread">
                    <strong role="status">{progress.message}</strong>
                    <span>{progress.percent}%</span>
                  </div>
                  <progress
                    max="100"
                    value={progress.percent}
                    aria-label="烧录进度"
                  />
                </div>
              )}
            </section>
          </section>
          <LogConsole workbench={workbench} rate={rate} setRate={setRate} />
        </div>
      </main>
      <HelpDialog dialogRef={helpDialog} onClose={() => setHelpOpen(false)} />
      <dialog
        ref={confirmDialog}
        aria-labelledby="confirm-title"
        onClose={beginWrite}
      >
        <h2 id="confirm-title">确认烧录</h2>
        {pending && <FlashSummary firmware={pending} chip={device?.chip} />}
        <p className="muted actions">
          {!bk && settings.eraseAll
            ? '将擦除整片 Flash。请确认现有设备数据可以清除。'
            : pending?.kind === 'segments'
              ? '将擦除镜像覆盖的 Flash 扇区。'
              : '烧录后请重新配网和绑定设备。'}
        </p>
        <form method="dialog" className="row dialog-actions actions">
          <button className="btn" value="cancel">
            返回
          </button>
          <button className="btn primary" value="flash" disabled={!device}>
            确认写入
          </button>
        </form>
      </dialog>
      {fullscreenError && (
        <div className="toast" role="status">
          {fullscreenError}
        </div>
      )}
    </>
  );
}
