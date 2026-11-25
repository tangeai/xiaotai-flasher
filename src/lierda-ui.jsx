import { t } from './i18n.mjs';
import { useEffect, useState } from 'react';
import { lierdaBoards, prepareLierdaFirmware } from './lierda-firmware.mjs';
import { parseLierdaPackage } from './lierda-package.mjs';

export function lierdaBoardForLink(slug) {
  const canonical = slug === 'lierda-pro-f9' ? 'lierda-pro' : slug;
  return lierdaBoards.find((board) => board.slug === canonical);
}

export function initialLierdaSelection(board) {
  return {
    model: (board ?? lierdaBoards[0]).model,
    modelChosen: Boolean(board),
    versions: {},
    origin: 'official',
    file: null,
  };
}

export function matchesLierdaDevice({ model, chip, flashBytes }, device) {
  return device?.lierdaModel === model && device.chip === chip && device.capacity === flashBytes;
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
      <h2 id="firmware-title">{t('选择固件')}</h2>
      <div className="choices row" role="group" aria-label={t('选择固件来源')}>
        {[
          ['official', t('小钛固件')],
          ['local', t('本地 BINPKG')],
        ].map(([origin, label]) => (
          <label key={origin}>
            <input
              type="radio"
              className="sr-only"
              name="lierda-source"
              value={origin}
              checked={selection.origin === origin}
              disabled={busy}
              onChange={() => setSelection((current) => ({ ...current, origin, file: null }))}
            />{' '}
            {label}
          </label>
        ))}
      </div>
      <div className="options">
        {selection.origin === 'official' ? (
          <>
            <label className="field span">
              {t('开发板型号')}
              <select
                id="lierda-board"
                value={selection.model}
                disabled={busy}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {lierdaBoards.map(({ model, name }) => <option key={model} value={model}>{t(name)}</option>)}
              </select>
              <small>{t('按完整板卡型号选择固件。')}</small>
            </label>
            <label className="field span">
              {t('固件版本')}
              <select
                id="lierda-version"
                disabled={busy || !release}
                value={release?.version ?? ''}
                onChange={(event) => {
                  const version = event.target.value;
                  setSelection((current) => ({
                    ...current,
                    versions: { ...current.versions, [board.model]: version },
                  }));
                }}
              >
                {!release && (
                  <option value="">{releases === undefined ? t('正在读取…') : releases === null ? t('固件目录暂不可用') : t('暂无正式版本')}</option>
                )}
                {releases?.map(({ version, recommended, prerelease }) => (
                  <option key={version} value={version}>
                    {board.versionPrefix}{version}{prerelease ? t('（测试版）') : ''}{recommended ? t('（推荐）') : ''}
                  </option>
                ))}
              </select>
              {release && <small>{t('选择要写入的已发布版本。')}</small>}
            </label>
            {release && (
              <p className="callout span" id="manifest">
                {board.chip} · BINPKG · {board.model === 'pro-f9'
                  ? t('仅写入 APP 应用区')
                  : t('写入 BL、AP、CP 和 APP')}
              </p>
            )}
          </>
        ) : (
          <label className="field span">
            {t('本地 BINPKG')}
            <input
              type="file"
              id="lierda-binpkg"
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
      <div><dt>{t('目标芯片')}</dt><dd>{firmware.chip}</dd></div>
      <div><dt>{t('目标开发板')}</dt><dd>{t(firmware.boardModel)}</dd></div>
      <div><dt>{t('固件包')}</dt><dd>{firmware.filename}</dd></div>
      <div>
        <dt>{t('写入范围')}</dt>
        <dd>
          {firmware.model === 'pro-f9'
            ? t('APP 应用区，保留其余分区。')
            : t('BL、AP、CP 和 APP。可能清除绑定、设置和内部文件。')}
        </dd>
      </div>
    </dl>
  );
}
