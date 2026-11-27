const pmFlashBase = 0x00800000;

// OpenKit registers SDK_VERSION "_" APP_VERSION, which CGMR appends to the modem revision.
// Only explicit PM application families identify a variant. Generic factory or test builds do not.
export function classifyPmAppVersion(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = /^(?:\+CGMR:[ \t]*)?(?:F6D_D_V\d+-)?V\d+\.\d+\.\d+_appV([a-zA-Z0-9_.-]+)$/u.exec(value.trim());
  if (!match) return null;
  if (/^(?:lite_ai|lite_release)(?:_\d+(?:[._-]\d+)*)?$/u.test(match[1])) return 'lite';
  if (/^pro_release(?:_\d+(?:[._-]\d+)*)?$/u.test(match[1])) return 'pro-pm';
  return null;
}

function isThumbCall(view, offset) {
  return (view.getUint16(offset, true) & 0xf800) === 0xf000
    && (view.getUint16(offset + 2, true) & 0xd000) === 0xd000;
}

// In the supported SDK startup routine main initializes RW/ZI, passes a read-only
// string to __Liot_SetAppSdkversion, registers the errno callback and starts the app.
// Follow the argument of this specific call, so spare strings elsewhere never vote.
function registeredVersionAddress(code, mappedEntry, mappedEnd) {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  if (view.getUint16(0, true) !== 0xb508 || !isThumbCall(view, 2) || !isThumbCall(view, 6)
      || !isThumbCall(view, 12) || !isThumbCall(view, 18)
      || view.getUint32(22, true) !== 0x4008e8bd
      || (view.getUint16(26, true) & 0xf800) !== 0xf000
      || (view.getUint16(28, true) & 0xd000) !== 0x9000) return null;

  function literalOffset(offset) {
    const op = view.getUint16(offset, true);
    if ((op & 0xff00) !== 0x4800) return -1; // LDR r0, [PC, #imm]
    const pc = (mappedEntry + offset + 4) & ~3;
    return pc + (op & 0xff) * 4 - mappedEntry;
  }
  const versionSlot = literalOffset(10);
  const callbackSlot = literalOffset(16);
  if ([versionSlot, callbackSlot].some(o => o < 30 || o + 4 > code.length)
      || versionSlot === callbackSlot) return null;
  const callback = view.getUint32(callbackSlot, true);
  const version = view.getUint32(versionSlot, true);
  if (!(callback & 1) || callback < mappedEntry + 1 || callback >= mappedEnd
      || version < mappedEntry + code.length || version >= mappedEnd) return null;
  return version;
}

async function readExactly(readFlash, offset, length) {
  const bytes = await readFlash(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new RangeError('Incomplete PM application read');
  return bytes;
}

// This older PM build registered a generic application name. Its active
// touch-display driver and its referenced display descriptor match a verified
// factory image. Only use the pair for this build, within the shared PM layout.
async function matchesLegacyTouchApp(readFlash, appStart) {
  const probe = new Uint8Array(224);
  probe.set(await readExactly(readFlash, appStart + 0x900, 128));
  probe.set(await readExactly(readFlash, appStart + 0xd37a0, 96), 128);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', probe));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') ===
    '62bc81e9d4fcf1935812f9924483abcfcb4876d0b95c7537bb1c3a0de821e285';
}

// readFlash takes offsets relative to internal Flash. Transport errors propagate.
// A BINPKG reader can narrow the upper bound to the file's actual APP payload.
export async function readPmApplicationModel(header, app, readFlash, imageLength = app?.capacity) {
  if (!(header instanceof Uint8Array) || header.length < 24 || !app
      || app.address !== 0x2a6000 || !Number.isInteger(app.fsStart) || app.fsStart > 0x400000
      || app.capacity !== app.fsStart - app.address || !Number.isInteger(imageLength)
      || imageLength < 24 || imageLength > app.capacity) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== 0x30707061 || view.getUint32(16, true) !== app.fsStart
      || view.getUint32(20, true) !== app.fsSize) return null;
  const mappedStart = pmFlashBase + app.address;
  const mappedEnd = mappedStart + imageLength;
  const thumbEntry = view.getUint32(4, true);
  const entry = thumbEntry - 1;
  const codeLength = 40;
  if (!(thumbEntry & 1) || entry < mappedStart + 24 || entry + codeLength > mappedEnd) return null;

  const code = await readExactly(readFlash, entry - pmFlashBase, codeLength);
  const address = registeredVersionAddress(code, entry, mappedEnd);
  if (address === null) return null;
  const size = Math.min(96, mappedEnd - address);
  const bytes = await readExactly(readFlash, address - pmFlashBase, size);
  const end = bytes.indexOf(0);
  if (end <= 0) return null;
  const version = String.fromCharCode(...bytes.subarray(0, end));
  // CGMR labels and whitespace belong to the serial protocol, never the C string.
  if (!/^V[0-9]/u.test(version) || version !== version.trim()) return null;
  if (version === 'V1.7.0_appVai_only' && app.fsStart === 0x3bc000
      && address === mappedStart + 0xd318c && imageLength >= 0xd3800
      && await matchesLegacyTouchApp(readFlash, app.address)) return 'pro-pm';
  return classifyPmAppVersion(version);
}
