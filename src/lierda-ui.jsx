import { useEffect, useState } from 'react';
import {
  lierdaBoards, loadLierdaLiteReleases, loadLierdaProRelease, prepareLierdaFirmware,
} from './lierda-firmware.mjs';
import { parseLierdaPackage } from './lierda-package.mjs';

export function lierdaBoardForLink(slug) {
  const canonical = slug === 'lierda-pro-f9' ? 'lierda-pro' : slug;
  return lierdaBoards.find((board) => board.slug === canonical);
}

export function initialLierdaSelection(board) {
  return {
    model: (board ?? lierdaBoards[0]).model,
    modelChosen: Boolean(board),
    liteVersion: null,
    origin: null,
    file: null,
  };
}

export function matchesLierdaDevice({ model, chip, flashBytes }, device) {
  return device?.lierdaModel === model && device.chip === chip && device.capacity === flashBytes;
}

function useLierdaManifest(enabled, load) {
  const [release, setRelease] = useState(undefined);

  useEffect(() => {
    if (!enabled || release !== undefined) return;
    const abort = new AbortController();
    load(abort.signal).then(
      (available) => {
        if (!abort.signal.aborted) setRelease(available);
      },
      () => {
        if (!abort.signal.aborted) setRelease(null);
      },
    );
    return () => abort.abort();
  }, [enabled, load, release]);

  return release;
}

export function useLierdaReleases(board, enabled) {
  const lite = board.model === 'lite';
  const liteReleases = useLierdaManifest(enabled && lite, loadLierdaLiteReleases);
  const proRelease = useLierdaManifest(enabled && !lite, loadLierdaProRelease);
  if (lite) return liteReleases?.length ? liteReleases : [board.release];
  return proRelease ? [proRelease] : proRelease;
}

export function useLierdaPreflight(selection, enabled) {
  const { model, origin } = selection;
  const file = enabled && origin === 'local' ? selection.file : null;
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!file) return;
    let canceled = false;
    (async () => {
      try {
        const { filename } = prepareLierdaFirmware({ model, file, origin: 'local' });
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (canceled) return;
        await parseLierdaPackage(bytes, { model, stage: 'app', filename });
        if (!canceled) setResult({ file, model, valid: true });
      } catch {
        if (!canceled) setResult({ file, model, valid: false });
      }
    })();
    return () => { canceled = true; };
  }, [file, model]);

  if (!file) return 'ready';
  if (result?.file !== file || result.model !== model) return 'checking';
  return result.valid ? 'ready' : 'invalid';
}

export function LierdaFirmwarePicker({ board, releases, release, selection, setSelection, onModelChange, busy }) {
  return (
    <>
      <h2 id="firmware-title">选择固件</h2>
      <div className="choices row" role="group" aria-label="选择固件来源">
        {[
          ['official', '小钛固件'],
          ['local', '本地 BINPKG'],
        ].map(([origin, label]) => (
          <label key={origin}>
            <input
              type="radio"
              className="sr-only"
              name="lierda-source"
              value={origin}
              checked={selection.origin === origin}
              disabled={busy || (origin === 'official' && !release)}
              onChange={() => setSelection((current) => ({ ...current, origin, file: null }))}
            />{' '}
            {label}
          </label>
        ))}
      </div>
      <div className="options">
        <label className="field span">
          开发板型号
          <select
            id="lierda-board"
            value={selection.model}
            disabled={busy}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {lierdaBoards.map(({ model, name }) => <option key={model} value={model}>{name}</option>)}
          </select>
        </label>
        {selection.origin === 'official' ? (
          release ? (
            <>
              <label className="field span">
                固件版本
                <select
                  id="lierda-version"
                  disabled={busy}
                  value={release.version}
                  onChange={(event) => {
                    const version = event.target.value;
                    if (selection.model === 'lite') {
                      setSelection((current) => ({ ...current, liteVersion: version }));
                    }
                  }}
                >
                  {releases.map(({ version, recommended }) => (
                    <option key={version} value={version}>
                      {version}{recommended ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="callout span" id="manifest">{board.chip} · {release.filename}</p>
            </>
          ) : (
            <p className="muted span" id="manifest" role="status">
              {releases === undefined ? '正在读取小钛固件目录…' : '该板型暂无小钛固件。'}
            </p>
          )
        ) : (
          <label className="field span">
            本地 BINPKG
            <input
              type="file"
              id="lierda-binpkg"
              key={selection.model}
              accept=".binpkg"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files[0] ?? null;
                setSelection((current) => ({ ...current, origin: 'local', file }));
              }}
            />
          </label>
        )}
      </div>
    </>
  );
}

export function LierdaFlashSummary({ firmware }) {
  return (
    <dl className="flash-summary">
      <div><dt>目标芯片</dt><dd>{firmware.chip}</dd></div>
      <div><dt>目标开发板</dt><dd>{firmware.boardModel}</dd></div>
      <div><dt>固件包</dt><dd>{firmware.filename}</dd></div>
      <div>
        <dt>写入范围</dt>
        <dd>
          {firmware.model === 'pro-f9'
            ? 'APP 应用区，保留其余分区。'
            : 'BL、AP、CP 和 APP。可能清除绑定、设置和内部文件。'}
        </dd>
      </div>
    </dl>
  );
}
