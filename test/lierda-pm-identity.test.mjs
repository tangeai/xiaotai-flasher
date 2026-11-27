import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPmAppVersion, readPmApplicationModel } from '../src/lierda-pm-identity.mjs';

const layout = { address: 0x2a6000, capacity: 0x116000, fsStart: 0x3bc000, fsSize: 0x28000 };
const mapped = 0x00800000 + layout.address;

// Synthetic startup for the SDK that registers the version as its third call.
function fixture(version, entry = 0x148, stringOffset = 0x250) {
  const data = new Uint8Array(Math.max(0x500, stringOffset + 96));
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode('app0'));
  view.setUint32(4, mapped + entry + 1, true);
  view.setUint32(16, layout.fsStart, true);
  view.setUint32(20, layout.fsSize, true);
  data.set(Buffer.from('08b500f000f800f000f8054800f000f8044800f000f8bde8084000f000b800bf', 'hex'), entry);
  view.setUint32(entry + 32, mapped + stringOffset, true);
  view.setUint32(entry + 36, mapped + entry + 41, true);
  data.set(new TextEncoder().encode(version), stringOffset);
  const reads = [];
  function readFlash(offset, length) {
    const local = offset - layout.address;
    assert.ok(local >= 0 && local + length <= data.length);
    reads.push([local, length]);
    return data.subarray(local, local + length);
  }
  const header = data.subarray(0, 24);
  return { data, header, view, reads, readFlash, model: () => readPmApplicationModel(header, layout, readFlash, data.length) };
}

test('CGMR and APP records require one explicit, complete PM version', () => {
  for (const [value, model] of [
    ['V1.7.0_appVlite_release', 'lite'],
    ['+CGMR: F6D_D_V0101-V1.7.0_appVlite_ai_1.2.3_20261121', 'lite'],
    ['F6D_D_V0101-V1.7.0_appVpro_release', 'pro-pm'],
    ['V1.7.0_appVai_only', null],
    ['V1.7.0_appVpro_release_lite', null],
    ['V1.7.0_appVpro_f9d_d_wxav605_sdk170', null],
    ['+CGMR: F9D_D_V0101-V1.7.0_appVpro_release', null],
    ['V1.7.0_appVlite_release\r\nV1.7.0_appVpro_release', null],
    ['V1.7.0_appVpro_release extra log', null],
  ]) assert.equal(classifyPmAppVersion(value), model);
});

test('reads the registered startup argument even when another valid version exists elsewhere', async () => {
  for (const [version, entry, expected] of [
    ['V1.7.0_appVlite_ai_1.1.4_20261121', 0x150, 'lite'],
    ['V1.7.0_appVpro_release', 0x148, 'pro-pm'],
  ]) {
    const f = fixture(version, entry);
    f.data.set(new TextEncoder().encode('V1.7.0_appVlite_release'), 0x350);
    assert.equal(await f.model(), expected);
    assert.deepEqual(f.reads, [[entry, 40], [0x250, 96]]);
  }
});

test('out-of-bounds pointers, unsupported instructions and unterminated versions stay unidentified', async () => {
  const f = fixture('V1.7.0_appVpro_release');
  const badInputs = [
    () => f.view.setUint32(4, mapped + 0x148, true),
    () => f.view.setUint32(4, mapped + f.data.length - 1, true),
    () => f.view.setUint32(16, layout.fsStart + 0x1000, true),
  ];
  for (const change of badInputs) {
    const original = f.data.slice(0, 24);
    change();
    assert.equal(await f.model(), null);
    assert.deepEqual(f.reads, []);
    f.data.set(original);
  }
  for (const change of [
    () => f.view.setUint32(0x168, mapped + f.data.length, true),
    () => f.view.setUint16(0x152, 0x49ff, true),
    () => f.view.setUint16(0x154, 0, true),
    () => f.view.setUint16(0x158, 0x4803, true), // aliases the version's literal
  ]) {
    const original = f.data.slice();
    change();
    assert.equal(await f.model(), null);
    assert.deepEqual(f.reads.splice(0), [[0x148, 40]]);
    f.data.set(original);
  }
  f.data.fill(0x61, 0x250, 0x250 + 96);
  assert.equal(await f.model(), null);
  const shortLength = 0x250 + 'V1.7.0_appVpro_release'.length;
  f.data.set(new TextEncoder().encode('V1.7.0_appVpro_release'), 0x250);
  assert.equal(await readPmApplicationModel(f.header, layout, f.readFlash, shortLength), null);
  assert.deepEqual(f.reads.at(-1), [0x250, shortLength - 0x250]);
});

test('a generic legacy version alone is insufficient and read errors propagate', async () => {
  const f = fixture('V1.7.0_appVai_only', 0x148, 0xd318c);
  assert.equal(await f.model(), null); // Actual payload ends before the fingerprint.
  const reads = [];
  const readWithEmptyFlash = (offset, length) => {
    reads.push([offset - layout.address, length]);
    return offset - layout.address + length <= f.data.length ? f.readFlash(offset, length) : new Uint8Array(length);
  };
  assert.equal(await readPmApplicationModel(f.header, layout, readWithEmptyFlash), null);
  assert.deepEqual(reads.slice(-2), [[0x900, 128], [0xd37a0, 96]]);
  const failure = new Error('LPC CRC mismatch');
  await assert.rejects(readPmApplicationModel(f.header, layout, () => { throw failure; }), e => e === failure);
  await assert.rejects(readPmApplicationModel(f.header, layout, () => new Uint8Array(4)), /Incomplete PM/);
});
