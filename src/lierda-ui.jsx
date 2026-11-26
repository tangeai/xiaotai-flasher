import { FirmwareFileInput } from './FirmwareFileInput.jsx';
import { LocalizedError, localizedMessage, t } from './i18n.mjs';
import { useEffect, useState } from 'react';
import { resolveLierdaFirmware } from './lierda-firmware.mjs';
import { parseLierdaPackage } from './lierda-package.mjs';

export function matchesLierdaDevice({ model, chip, flashBytes }, device) {
  return device?.lierdaModel === model && device.chip === chip && device.capacity === flashBytes;
}

export function useLierdaPreflight(selection, enabled, selectedRelease) {
  const { model, origin } = selection;
  const file = enabled && origin === 'local' ? selection.file : null;
  const release = enabled && origin === 'official' ? selectedRelease : null;
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!file && !release) return;
    const controller = new AbortController();
    (async () => {
      try {
        const input = await resolveLierdaFirmware({ kind: 'lierda', model, file, release, origin }, controller.signal);
        const plan = await parseLierdaPackage(input.bytes, input);
        if (!controller.signal.aborted) setResult({ file, release, model, attempt, status: 'ready', input, profile: plan.profile });
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof LocalizedError ? error : localizedMessage('无法校验固件。@0', error);
        setResult({ file, release, model, attempt, status: 'invalid', error: detail });
      }
    })();
    return () => controller.abort();
  }, [file, release, model, origin, attempt]);

  if (!file && !release) return { status: 'idle' };
  if (!result || result.file !== file || result.release !== release || result.model !== model || result.attempt !== attempt) return { status: 'checking' };
  if (release && result.status === 'invalid') return { ...result, retry: () => setAttempt(value => value + 1) };
  return result;
}

export function LierdaFirmwarePicker({ board, boardPicker, releases, release, selection, setSelection, busy }) {
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
              onChange={() => setSelection((current) => ({ ...current, origin }))}
            />{' '}
            {label}
          </label>
        ))}
      </div>
      <div className="options">
        {selection.origin === 'official' && (
          <>
            {boardPicker}
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
                    {version}{prerelease ? t('（测试版）') : ''}{recommended ? t('（推荐）') : ''}
                  </option>
                ))}
              </select>
            </label>
            {release && (
              <p className="callout span" id="manifest" title={release.source_filename}>
                {release.filename}
              </p>
            )}
          </>
        )}
        <label className="field span" hidden={selection.origin !== 'local'}>
          {t('本地 BINPKG')}
          <FirmwareFileInput
            file={selection.file}
            id="lierda-binpkg"
            accept=".binpkg"
            disabled={busy}
            onFileChange={file => {
              setSelection((current) => ({ ...current, origin: 'local', file }));
            }}
          />
        </label>
      </div>
    </>
  );
}

export function LierdaFlashSummary({ firmware }) {
  const profile = firmware.targetDevice.lierdaProfile;
  const { mode, eraseRanges } = firmware.writePlan;
  const offset = (value) => '0x' + value.toString(16).padStart(6, '0').toUpperCase();
  return (
    <dl className="flash-summary">
      <div><dt>{t('目标芯片')}</dt><dd>{firmware.chip}</dd></div>
      <div><dt>{t('目标开发板')}</dt><dd>{t(firmware.boardModel)}</dd></div>
      <div><dt>{t('固件包')}</dt><dd>{firmware.filename}</dd></div>
      <div><dt>{t('写入前备份')}</dt><dd>{t('全部内部 Flash（@0 MiB）', profile.size / 0x100000)}</dd></div>
      <div>
        <dt>{t('擦除范围（内部 Flash 偏移）')}</dt>
        <dd>{eraseRanges.map(({ start, end }) => (
          <div key={start}><code>{offset(start)}–{offset(end - 1)}</code></div>
        ))}</dd>
      </div>
      <div>
        <dt>{t('写入范围')}</dt>
        <dd>
          {mode === 'reinstall'
            ? t('将重装底包和 APP，清空应用文件系统。设备绑定、设置及内部文件将丢失。保留并校验出厂数据及校准区。')
            : mode === 'app' ? t('APP 应用区，保留其余分区。')
            : t('BL、AP、CP 和 APP。可能清除绑定、设置和内部文件。')}
        </dd>
      </div>
    </dl>
  );
}
