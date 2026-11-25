import english from './en.json' with { type: 'json' };

const storageKey = 'xiaotai-flasher.language';
let language = 'zh-CN';
try {
  if (globalThis.localStorage?.getItem(storageKey) === 'en') language = 'en';
} catch {
  // The workbench can also run with browser storage disabled.
}

export const getLanguage = () => language;

export function setLanguage(value) {
  language = value === 'en' ? 'en' : 'zh-CN';
  try {
    globalThis.localStorage?.setItem(storageKey, language);
  } catch {
    // Keep the selection for this session.
  }
}

// Keep the template and its original arguments until a status or error is displayed.
export function localizedMessage(key, ...values) {
  return { toString: () => t(key, ...values) };
}

export class LocalizedError extends Error {
  constructor(detail, options) {
    super(undefined, options);
    this.detail = detail;
  }

  get message() {
    return t(this.detail);
  }
}

export function t(key, ...values) {
  if (key instanceof Error) return key.message;
  if (typeof key !== 'string') return String(key);
  const template = language === 'en' && Object.hasOwn(english, key) ? english[key] : key;
  if (!values.length) return template;
  return template.replace(/@(\d+)/g, (_, index) => {
    const value = values[index];
    return value instanceof Error ? value.message : String(value);
  });
}

export function releaseLabel(version) {
  return language === 'en'
    ? version.replaceAll('（测试版）', ' (beta)').replaceAll('（特别版）', ' (special edition)')
    : version;
}
