import { LocalizedError, localizedMessage } from './i18n.mjs';

export const LIERDA_AGENTBOOT_PATH = 'lierda/agentboot-ec718pm-usb.bin';
export const LIERDA_AGENTBOOT_BYTES = 50_032;
export const LIERDA_AGENTBOOT_SHA256 = '045bd0c74a030143230f07484e4711600005b992e3b0776be042e42d141a38e5';

export async function verifyLierdaAgentBoot(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== LIERDA_AGENTBOOT_BYTES) {
    throw new LocalizedError(localizedMessage('AgentBoot 文件长度不匹配，应为 @0 字节', LIERDA_AGENTBOOT_BYTES));
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hexDigest = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hexDigest !== LIERDA_AGENTBOOT_SHA256) {
    throw new LocalizedError('AgentBoot SHA-256 与已验证的 USB 镜像不一致');
  }
  return digest;
}

export async function loadLierdaAgentBoot(signal) {
  const timeout = AbortSignal.timeout(10_000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = new URL('./' + LIERDA_AGENTBOOT_PATH, globalThis.document?.baseURI ?? import.meta.url);
  try {
    const response = await fetch(url, { signal: downloadSignal });
    if (!response.ok) {
      throw new LocalizedError(localizedMessage('无法加载 USB AgentBoot · HTTP @0', response.status));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyLierdaAgentBoot(bytes);
    downloadSignal.throwIfAborted();
    return bytes;
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new LocalizedError('加载 USB AgentBoot 超时。', { cause: error });
    throw error;
  }
}
