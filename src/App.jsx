import { previewOffset, timestampedPreview } from './serial-preview.mjs';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import brandMark from './assets/xiaotai-brand-mark.png';
import { canonicalBoardSlug, loadBoards } from './catalog.mjs';
import { prepareFirmware } from './firmware.mjs';
import { bkSettingFields, settingFields } from './settings.mjs';
import { useWorkbench } from './useWorkbench.js';

const logRates = ['115200', '9600', '57600', '230400', '460800', '921600'];
const defaultSettings = Object.fromEntries(
  [...settingFields, ...bkSettingFields].map(([key, , options]) => [key, options[0][0]]),
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
    ? [...bkSettingFields, ...settingFields.filter(([key]) => key === 'after-reset')]
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
                (connected && ['before-reset', 'write-rate', 'bk-before-reset'].includes(key))
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
            下载使用 DL_UART0。日志波特率在右侧串口日志面板单独设置。
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

  const release = board?.versions.find(
    ({ version }) => version === selection.version,
  );
  return (
    <>
      <h2 id="firmware-title">选择固件</h2>
      <div className="choices row" role="group" aria-label="选择固件来源">
        <label>
          <input
            type="radio"
            className="sr-only"
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
            className="sr-only"
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
          开发板型号
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
          <small>
            {release?.embedded_version
              ? `设备上报版本：${release.embedded_version}`
              : '选择要写入的已发布版本。'}
          </small>
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

const logLevels = {
  I: 'info', INFO: 'info', OK: 'ok', SUCCESS: 'ok',
  W: 'warn', WARN: 'warn', WARNING: 'warn',
  E: 'error', ERR: 'error', ERROR: 'error',
};

const SerialLog = memo(function SerialLog({ text, matchStart, matchLength }) {
  // Match level prefixes after an optional timestamp, including ESP-IDF's I (123) form.
  const prefix = /^(?:\[\d{2}:\d{2}:\d{2}\.\d{3}\] )?(?:\x1b\[[0-9;]*m)*(?:\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?[ \t]+)?\[?(INFO|OK|SUCCESS|WARN(?:ING)?|ERR(?:OR)?|[IWE](?= \(\d+\)))\b/gm;
  const parts = [];
  function section(start, end) {
    const from = Math.max(start, matchStart);
    const to = Math.min(end, matchStart + matchLength);
    if (matchStart < 0 || from >= to) return text.slice(start, end);
    return <Fragment key={'match' + start}>{text.slice(start, from)}<mark>{text.slice(from, to)}</mark>{text.slice(to, end)}</Fragment>;
  }
  let offset = 0;
  for (const match of text.matchAll(prefix)) {
    const end = match.index + match[0].length;
    parts.push(section(offset, end - match[1].length));
    parts.push(<span className={`log-${logLevels[match[1]]}`} key={end}>{section(end - match[1].length, end)}</span>);
    offset = end;
  }
  return <>{parts}{section(offset, text.length)}</>;
});

function CommandForm({ workbench }) {
  const browsing = useRef(null);
  const [format, setFormat] = useState('text');
  const [drafts, setDrafts] = useState({ text: '', hex: '' });
  const command = drafts[format];
  const [ending, setEnding] = useState('\r\n');

  function recallCommand(event) {
    const history = workbench.commandHistory;
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !history.length || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    let cursor = browsing.current;
    if (cursor?.history !== history) {
      if (event.key === 'ArrowDown') return;
      cursor = { history, index: history.length, drafts, format, ending };
      browsing.current = cursor;
    }
    event.preventDefault();
    cursor.index = Math.max(0, Math.min(history.length, cursor.index + (event.key === 'ArrowUp' ? -1 : 1)));
    const entry = history[cursor.index];
    if (entry) {
      setFormat(entry.format);
      setEnding(entry.ending);
      setDrafts({ ...cursor.drafts, [entry.format]: entry.command });
    } else {
      setDrafts(cursor.drafts);
      setFormat(cursor.format);
      setEnding(cursor.ending);
      browsing.current = null;
    }
  }

  return (
    <form aria-label="串口发送" className="command-row" onSubmit={(event) => {
      event.preventDefault();
      workbench.sendCommand(command, format, ending);
    }}>
      <select aria-label="发送格式" value={format} onChange={(event) => { browsing.current = null; setFormat(event.target.value); }}>
        <option value="text">文本</option>
        <option value="hex">HEX</option>
      </select>
      <input
        type="text"
        aria-label="串口指令"
        placeholder={format === 'hex' ? '例如 AA 01 FF' : '输入串口指令'}
        autoComplete="off"
        spellCheck={false}
        value={command}
        title="↑ / ↓ 调出本次连接成功发送的指令"
        onKeyDown={recallCommand}
        onChange={(event) => { browsing.current = null; setDrafts({ ...drafts, [format]: event.target.value }); }}
      />
      {format === 'text' && <select aria-label="指令行尾" title="文本行尾" value={ending} onChange={(event) => { browsing.current = null; setEnding(event.target.value); }}>
        <option value={'\r\n'}>CR+LF</option>
        <option value={'\n'}>LF</option>
        <option value={'\r'}>CR</option>
        <option value="">无行尾</option>
      </select>}
      <button className="btn primary" type="submit" disabled={!workbench.canSend || workbench.busy || workbench.sending || !command}>
        发送指令
      </button>
    </form>
  );
}

function LogConsole({ workbench, rate, setRate, platform }) {
  const {
    tab,
    busy,
    monitoring,
    monitorReceived,
    monitorMessage,
    preview,
    flashLog,
    progress,
    complete,
    serialAvailable,
  } = workbench;
  const flashTab = tab === 'flash';
  const [paused, setPaused] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [matchAnchor, setMatchAnchor] = useState(0);
  const findField = useRef(null);
  const findButton = useRef(null);
  const [showTime, setShowTime] = useState(false);
  const bootLog = useMemo(() => showTime ? timestampedPreview(preview) : preview.text, [preview, showTime]);
  const matches = useMemo(() => {
    if (!finding || !query) return [];
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Array.from(bootLog.matchAll(new RegExp(literal, 'gi')), match => match.index);
  }, [finding, query, bootLog]);
  const displayedOffset = previewOffset(preview, showTime);
  const nextMatch = matches.findIndex(position => displayedOffset + position >= matchAnchor);
  const selected = nextMatch < 0 ? matches.length - 1 : nextMatch;
  const matchStart = matches[selected] ?? -1;
  const [copyStatus, setCopyStatus] = useState('');
  const deviceOutput = useRef(null);
  const flashOutput = useRef(null);
  const deviceTab = useRef(null);
  const processTab = useRef(null);
  useLayoutEffect(() => {
    if (!flashTab && !paused && !finding)
      deviceOutput.current.scrollTop = deviceOutput.current.scrollHeight;
  }, [bootLog, flashTab, paused, finding]);
  useLayoutEffect(() => {
    if (flashTab)
      flashOutput.current.scrollTop = flashOutput.current.scrollHeight;
  }, [flashLog, flashTab]);

  useLayoutEffect(() => {
    if (finding && !flashTab) findField.current?.focus();
  }, [finding, flashTab]);
  useLayoutEffect(() => {
    if (flashTab || matchStart < 0) return;
    const box = deviceOutput.current;
    const mark = box.querySelector('mark');
    if (!mark) return;
    const bounds = box.getBoundingClientRect();
    const target = mark.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom)
      box.scrollTop += target.top - bounds.top - box.clientHeight / 2;
  }, [matchStart, query, flashTab, preview.offset, showTime]);

  function closeFind() {
    setFinding(false);
    findButton.current?.focus();
  }

  function stepMatch(step) {
    if (matches.length) {
      const next = (selected + step + matches.length) % matches.length;
      setMatchAnchor(displayedOffset + matches[next]);
    }
  }

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
        <span className="console-status" data-outcome={flashTab ? progress?.outcome : undefined} role="status">
          {flashTab ? taskStatus : monitoring ? (monitorReceived ? '已收到日志' : '等待输出') : '未连接'}
        </span>
      </div>
      <div
        className="console-pane"
        id="device-log"
        role="tabpanel"
        aria-labelledby="log-tab"
        hidden={flashTab}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            setFinding(true);
            findField.current?.select();
          } else if (finding && event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            closeFind();
          }
        }}
      >
        <div className="row spread log-controls">
          <button
            className="btn primary"
            type="button"
            disabled={!serialAvailable || busy}
            onClick={() => workbench.toggleMonitor(rate, platform)}
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
          <Check checked={showTime} onChange={(event) => { setMatchAnchor(0); setShowTime(event.target.checked); }}>
            时间
          </Check>
          <Check checked={!paused && !finding} disabled={finding} onChange={(event) => setPaused(!event.target.checked)}>
            自动滚动
          </Check>
          <button type="button" className="btn find-toggle" ref={findButton} aria-label="查找日志"
            title="查找日志 (Ctrl / ⌘ + F)" aria-expanded={finding}
            onClick={() => finding ? closeFind() : setFinding(true)}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" /><path d="m12 12 5 5" />
            </svg>
          </button>
          <small className="sr-only" id="log-rate-help">
            UART 读取速率需与固件控制台配置一致。原生 USB 日志请按板卡说明连接。
          </small>
        </div>
        {finding && (
          <div className="row log-find" role="search" aria-label="查找串口日志">
            <input ref={findField} aria-label="查找内容" placeholder="查找日志" value={query}
              onChange={(event) => { setQuery(event.target.value); setMatchAnchor(0); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  stepMatch(event.shiftKey ? -1 : 1);
                }
              }} />
            <small role="status">{query && (matches.length ? (selected + 1) + ' / ' + matches.length : '无匹配')}</small>
            <button className="btn" type="button" aria-label="上一处" title="上一处" disabled={!matches.length} onClick={() => stepMatch(-1)}>↑</button>
            <button className="btn" type="button" aria-label="下一处" title="下一处" disabled={!matches.length} onClick={() => stepMatch(1)}>↓</button>
            <button className="btn" type="button" aria-label="关闭查找" title="关闭查找" onClick={closeFind}>×</button>
          </div>
        )}
        <pre
          ref={deviceOutput}
          id="monitor-output"
          aria-label="设备日志输出"
          tabIndex={0}
        >
          {bootLog ? <SerialLog text={bootLog} matchStart={matchStart} matchLength={query.length} /> : (monitoring ? '等待设备日志…' : '连接后显示设备日志。')}
        </pre>
        <CommandForm workbench={workbench} />
        {workbench.commandMessage && <small role="status">{workbench.commandMessage}</small>}
        <div className="row log-actions">
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={() => { setMatchAnchor(0); workbench.clearLog(); }}
          >
            清空日志
          </button>
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={() => copyLog(bootLog)}
          >
            复制日志
          </button>
          <button
            className="btn"
            type="button"
            disabled={!bootLog}
            onClick={downloadLog}
          >
            下载日志
          </button>
          {typeof window.showDirectoryPicker === 'function' && (
            <button
              className="btn"
              type="button"
              disabled={!monitoring || busy}
              onClick={workbench.toggleRecording}
            >
              {workbench.recording ? '停止记录' : '记录到文件夹'}
            </button>
          )}
        </div>
        <small role="status">{monitorMessage}</small>
        {workbench.recordingMessage && <small role="status">{workbench.recordingMessage}</small>}
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
            <dd>
              {firmware.release.version}
              {firmware.release.embedded_version && (
                <small>设备上报版本：{firmware.release.embedded_version}</small>
              )}
            </dd>
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
        <h2 id="help-title">FAQ</h2>
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
        <p>列表中已有开发板串口时，直接选择即可。若串口被占用，请关闭其他串口工具。</p>
        <dl className="driver-help">
          <dt>Windows</dt>
          <dd>
            在设备管理器中查看 COM 口。若提示缺少驱动，CH340 / CH341 可用
            <a href="https://www.wch-ic.com/downloads/ch341ser_exe.html" target="_blank" rel="noreferrer">沁恒驱动</a>。
          </dd>
          <dt>macOS</dt>
          <dd>
            若系统询问是否允许配件连接，请点「允许」。若仍找不到 CH340 / CH341 串口，可尝试
            <a href="https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html" target="_blank" rel="noreferrer">沁恒驱动</a>。
          </dd>
        </dl>
      </details>
      <details className="settings-group">
        <summary>无法进入下载模式</summary>
        <p>
          ESP32 按板卡指南操作 BOOT / RESET
          键，再使用高级设置里的「手动进入下载模式」。写入不稳定时可把烧录波特率降到
          115200。
        </p>
        <p className="actions">
          BK7258 请选择 DL_UART0。看到「等待下载握手」时，在 15 秒内按一下板上的 RESET 键。
          若已显示「下载串口已就绪」，可直接开始烧录。
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
    canReconnect,
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
        const requestedBoard = boards.find((board) => board.slug === requested) ??
          boards.find((board) => board.slug === canonicalBoardSlug(requested));
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
    changeSelection({ merged: null, segmented: false, segments: [newSegment()] });
    workbench.resetForPlatform();
    workbench.setTab('log');
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
        baudrate: bk ? Number(settings['bk-write-rate']) : undefined,
        flashMode: settings['flash-mode'],
        flashFreq: settings['flash-freq'],
        flashSize: settings['flash-size'],
        eraseAll: !bk && settings.eraseAll,
        compress: settings.compress,
      },
    });
  }

  function connectDevice(reusePort = false) {
    userSelected.current = true;
    workbench.connect(
      {
        platform,
        baudrate: Number(settings['write-rate']),
        before: settings[bk ? 'bk-before-reset' : 'before-reset'],
      },
      reusePort,
    );
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
  const showResetHint = bk && !device && !busy && !completed;
  return (
    <>
      <header className="app-header">
        <a className="brand" href="https://xiaotai.chat/" aria-label="小钛官网">
          <img
            className="brand-mark"
            src={brandMark}
            alt=""
            width="32"
            height="32"
          />
          <span className="brand-name">小钛</span>
        </a>
        <div className="app-title">
          <h1>固件烧录与串口日志工作台</h1>
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
            FAQ
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
              disabled={busy || Boolean(device) || workbench.monitoring}
              onChange={(event) => changePlatform(event.target.value)}
            >
              <option value="esp32">乐鑫 Espressif（ESP32 系列）</option>
              <option value="bk7258">博通集成 Beken（BK7258）</option>
            </select>
          </label>
          <p
            className={`device-status ${deviceError ? 'error' : device ? 'connected' : 'muted'}`}
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
            <>
              <button
                className="btn primary"
                type="button"
                disabled={busy || !serialAvailable}
                aria-describedby={showResetHint ? 'bk-reset-hint' : undefined}
                onClick={() => connectDevice(canReconnect)}
              >
                {canReconnect ? '重新连接' : '连接设备'}
              </button>
              {canReconnect && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !serialAvailable}
                  onClick={() => connectDevice()}
                >
                  选择其他串口
                </button>
              )}
            </>
          )}
          {showResetHint && (
            <p id="bk-reset-hint" className="reset-hint">
              选择 DL_UART0，看到「等待下载握手」时按一下 <kbd>RESET</kbd>。已自动连接可跳过。
            </p>
          )}
        </section>
        <div className="workbench">
          <section className="flash-panel" aria-labelledby="firmware-title">
            <div className="flash-settings">
              <FirmwarePicker
                key={platform}
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
                      onClick={() => workbench.showDeviceLog(rate, platform)}
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
                    <strong role="status" data-outcome={progress.outcome}>{progress.message}</strong>
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
          <LogConsole workbench={workbench} rate={rate} setRate={setRate} platform={platform} />
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
