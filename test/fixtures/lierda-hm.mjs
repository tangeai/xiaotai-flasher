import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const layouts = {
  '1.7.0': { apSize: 0x1dc000, appStart: 0x2c1000, fsStart: 0x575000, fsSize: 0x262000 },
  '1.7.1': { apSize: 0x1c8000, appStart: 0x2ad000, fsStart: 0x561000, fsSize: 0x276000 },
};
const xip = 0x800000;
const headId = 0x54494d48;
const bootPages = new Map([[0x4f424d49, 0], [0x444b4249, 0x1000]]);
const sharedBootSample = '87ee2d2b52216763d21d24aea181ae4bc20bec8681e1c3464f3c1c00c77f21dd';
const cp = ['64e88a6b97954749403c4b1a6fed765552a67e033f1cc9e6ee883914aef7ba2b',
  '53bd8180c6ab918866c835f63c626a33ded3559fe6ac2a8fd90c660aa058bba7'];
// SHA-256 of each shipped base image and its 240-byte identification sample.
const signatures = {
  '1.7.0': [
    ['6743229009df330455c6bb9ecd3cf6324c386ee8b733d0d557cb08ab1e3385d1', sharedBootSample],
    ['9292a1d1b7c33168dab10bc0bb66c27dd53a1204889a2feaf325cc31e20eecb1',
      '421b0d5cb8f195e98262f1efc537e64b5428e7a01c572fda8e0d9106e6cf3729'], cp,
  ],
  '1.7.1': [
    ['c56c680fff74f274324e1ff17b0ce236be254bd684971c67ae0f694fb47caf55', sharedBootSample],
    ['7408bf96a569e6cb7b6854e547529beff065d5b56e950dc4cdf91e3859ddadae',
      '26d07457145adb4e006dbe2eda0b0f5b12136d20d2df3a108a4389ae3747d015'], cp,
  ],
};

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Observed 4 KiB factory BL/AP pages start with one 272-byte image header.
function populateBootPage(memory, page, id, image, imageSha) {
  const header = Buffer.alloc(272);
  header.writeUInt32LE(0x10000001, 0);
  header.writeUInt32LE(headId, 4);
  header.writeUInt32LE(0x20180507, 8);
  header.writeUInt32LE(1, 16);
  header[20] = 0xee;
  header.writeUInt32LE(4, 24);
  header.writeUInt32LE(id, 64);
  header.writeUInt32LE(image.start, 68);
  header.writeUInt32LE(0x04010000, 72);
  header.writeUInt32LE(image.bytes.length, 76);
  Buffer.from(imageSha, 'hex').copy(header, 96);
  createHash('sha256').update(header).digest().copy(header, 32);
  memory.fill(0xff, page, page + 0x1000);
  header.copy(memory, page);
}

function firmwarePackage(model, product, images, pinnedHashes) {
  const metadata = Buffer.alloc(52 + 280);
  metadata.write('111\0\0\0\0\0bpkg');
  metadata.writeUInt32LE(images.length, 16);
  metadata.write('SHA256', 20);
  metadata.writeUInt16LE(2, 28);
  metadata.writeUInt16LE(280, 30);
  metadata.writeUInt32LE(1, 52);
  metadata.write('pkgmode', 56);
  metadata.writeUInt32LE(1, 120);
  metadata.writeUInt32LE(2, 192);
  metadata.write('productname', 196);
  metadata.write(product, 260);
  const chunks = [metadata];
  let offset = metadata.length;
  for (const { name, type, start, storageAddress, capacity, bytes } of images) {
    const header = Buffer.alloc(364);
    header.write(name);
    header.writeUInt32LE(storageAddress ?? xip + start, 64);
    header.writeUInt32LE(capacity ?? bytes.length, 68);
    header.writeUInt32LE(offset, 72);
    header.writeUInt32LE(bytes.length, 76);
    header.write(pinnedHashes.get(sha(bytes)) ?? sha(bytes), 80);
    header.write(type, 336);
    chunks.push(header, bytes);
    offset += header.length + bytes.length;
  }
  const bytes = Buffer.concat(chunks);
  return { model, stage: 'app', bytes, sha256: sha(bytes) };
}

// Use deterministic stand-ins for the vendor binaries.
// Only their exact full-image and detection-sample digests get a pinned identity.
export function makeHmFixture(version, pinnedHashes) {
  const layout = layouts[version];
  const is170 = version === '1.7.0';
  const bases = [
    { name: 'ap_bootloader', type: 'BL', start: 0x3000, bytes: Buffer.alloc(0x20000, is170 ? 0x40 : 0x41) },
    { name: 'ap_lierda_app', type: 'AP', start: 0xcd000, bytes: Buffer.alloc(layout.apSize, is170 ? 0x50 : 0x51) },
    { name: 'cp-demo-flash', type: 'CP', start: 0x2d000, bytes: Buffer.alloc(0xa0000, 0x61) },
  ];
  bases[0].bytes.fill(0xb0, 0x100, 0x100 + 240);
  for (const [index, image] of bases.entries()) {
    const [imageSha, sampleSha] = signatures[version][index];
    pinnedHashes.set(sha(image.bytes), imageSha);
    const offset = index === 0 ? 0x100 : 0;
    pinnedHashes.set(sha(image.bytes.subarray(offset, offset + 240)), sampleSha);
  }

  function application(headerLayout) {
    // Cross a 64 KiB boundary to exercise multiple AGBOOT transfers.
    const bytes = Buffer.alloc(0x10400, is170 ? 0x71 : 0x72);
    bytes.write('app0');
    bytes.writeUInt32LE(headerLayout.fsStart, 16);
    bytes.writeUInt32LE(headerLayout.fsSize, 20);
    return bytes;
  }

  function firmware(headerLayout = layout) {
    const app = { name: 'TiRTC_pro_NT26F9D0', type: 'PKGFLXAPP', start: layout.appStart,
      capacity: 0x2b4000, bytes: application(headerLayout) };
    return firmwarePackage('pro-f9', 'EC718HM_PRD', [...bases, app], pinnedHashes);
  }

  const memory = Buffer.alloc(0x800000, 0x5b);
  populateBootPage(memory, 0, 0x4f424d49, bases[0], signatures[version][0][0]);
  populateBootPage(memory, 0x1000, 0x444b4249, bases[1], signatures[version][1][0]);
  for (const { start, bytes } of bases) bytes.copy(memory, start);
  const app = application(layout);
  app.copy(memory, layout.appStart, 0, 24);
  return { layout, memory, firmware, app, bases };
}

export function populatePmSdkEntry(bytes, start, model) {
  const relative = model === 'pro-pm' ? 0x148 : 0x150;
  const base = xip + 0x2a6000;
  const version = model === 'pro-pm' ? 'V1.7.0_appVpro_release' : 'V1.7.0_appVlite_ai_1.1.4_20261121';
  const main = Buffer.from('08b500f055f800f047f80548abf0aefa0448abf033fabde8084000f013b800bf0000000000000000', 'hex');
  main.writeUInt32LE(base + 0x3000, 0x20);
  main.writeUInt32LE(base + relative + 0x29, 0x24);
  bytes.writeUInt32LE(base + relative + 1, start + 4);
  main.copy(bytes, start + relative);
  bytes.write(version + '\0', start + 0x3000);
}

export function makePmFixture(profile, pinnedHashes) {
  const memory = Buffer.alloc(profile.size, 0x5b);
  const bases = profile.baseImages.map(({ name, role, address, capacity, digest, sampleSha }, index) => {
    const bytes = Buffer.alloc(capacity, 0x41 + index);
    const offset = role === 'BL' ? 0x100 : 0;
    pinnedHashes.set(sha(bytes), digest);
    pinnedHashes.set(sha(bytes.subarray(offset, offset + 240)), sampleSha);
    bytes.copy(memory, address);
    return { name, type: role, start: address, bytes };
  });
  populateBootPage(memory, 0, 0x4f424d49, bases[0], profile.baseImages[0].digest);
  populateBootPage(memory, 0x1000, 0x444b4249, bases[1], profile.baseImages[1].digest);
  const app = Buffer.alloc(0x10400, 0x71);
  app.write('app0');
  app.writeUInt32LE(profile.app.fsStart, 16);
  app.writeUInt32LE(profile.app.fsSize, 20);
  populatePmSdkEntry(app, 0, profile.model);
  app.copy(memory, profile.app.address, 0, 0x3080);
  const images = [...bases, { name: profile.app.name, type: 'PKGFLXAPP',
    start: profile.app.address, capacity: profile.app.capacity, bytes: app }];
  let resource;
  let external;
  if (profile.externalSize) {
    external = Buffer.alloc(profile.externalSize, 0xac);
    // Distinguish each block so duplicated or incorrect offsets are detectable.
    resource = Buffer.alloc(external.length);
    for (let offset = 0; offset < resource.length; offset += 0x10000) {
      resource.fill(offset / 0x10000, offset, offset + 0x10000);
    }
    resource.write('littlefs', 8);
    images.push({ name: 'ext_lfs', type: 'EFID01', storageAddress: 0x80000000, bytes: resource });
  }
  return { memory, external, resource, app, firmware: firmwarePackage(profile.model, profile.product, images, pinnedHashes) };
}

export function simulateHmFlash(memory, { onImageWritten, external, uid } = {}) {
  let target = memory;
  let programming = false;
  let selectedId;
  let imageId;
  let imageHeader;
  let cursor;
  let saved = false;
  const erased = [];
  const prepared = [];
  const written = [];
  const externalWritten = [];
  function word(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  }
  return {
    erased, prepared, written, externalWritten,
    get programming() { return programming; },
    markBackupSaved() { saved = true; },
    reply(frame) {
      const code = frame[0];
      const payloadLength = frame.readUIntLE(4, 3);
      const data = frame.subarray(8, 8 + payloadLength);
      if (frame[2] === 0x4c) {
        if (code === 0x21 || code === 0x10) {
          const length = data.readUInt32LE(0);
          const start = data.readUInt32LE(4) - xip;
          assert.ok(start >= 0 && start + length <= memory.length);
          if (code === 0x21) return memory.subarray(start, start + length);
          assert.ok(saved, 'erase before backup confirmation');
          assert.equal(length, 0x1000);
          erased.push(start);
          memory.fill(0xff, start, start + length);
        } else if (code === 0x25 && uid) {
          assert.equal(data.toString('hex'), '01e0');
          return uid;
        } else if (code === 0x24 && external) {
          assert.equal(data.readUInt32LE(), 1);
          assert.equal(data.subarray(15, 21).toString(), 'EFID01');
          const start = data.readUInt32LE(4);
          assert.equal(start % 0x10000, 0);
          assert.ok(start + 0x10000 <= external.length);
          return external.subarray(start, start + 0x10000);
        } else if (code === 0xe0 && external) {
          const command = data.readUInt32LE();
          if (command === 0x101) return word(1);
          assert.equal(command, 0x142);
          assert.ok(saved, 'external write before backup confirmation');
          assert.equal(data.subarray(10, 16).toString(), 'EFID01');
          assert.equal(data.readUInt32LE(29), 0x80000000);
          assert.equal(data.readUInt32LE(33), 0);
          assert.equal(data.readUInt32LE(37), external.length);
          target = external;
          imageId = data.readUInt32LE(25);
          programming = true;
          selectedId = headId;
        } else if (code === 0x42) {
          target = memory;
          imageId = data.readUInt32LE();
          prepared.push(imageId);
          programming = true;
          selectedId = headId;
        } else if (code === 0x44) {
          programming = false;
          const page = bootPages.get(imageId);
          if (page !== undefined) {
            memory.fill(0xff, page, page + 0x1000);
            imageHeader.copy(memory, page);
          }
          onImageWritten?.(imageId, target);
          return word(0);
        } else if (code === 0xaa) {
          return Buffer.from('5a7a5a7a5a7a5a7a', 'hex');
        } else {
          assert.fail('Unexpected LPC command ' + code);
        }
      } else {
        switch (code) {
          case 0x20: case 0x22: break;
          case 0x21: return word(selectedId);
          case 0x31: return data;
          case 0x32:
            if (selectedId === headId) {
              assert.equal(data.readUInt32LE(64), imageId);
              imageHeader = Buffer.from(data);
              cursor = data.readUInt32LE(68);
            } else {
              assert.ok(cursor + data.length <= target.length);
              const chunks = target === memory ? written : externalWritten;
              chunks.push({ start: cursor, length: data.length });
              data.copy(target, cursor);
              cursor += data.length;
            }
            break;
          case 0x3a: selectedId = imageId; break;
          default: assert.fail('Unexpected AGBOOT command ' + code);
        }
      }
      return Buffer.alloc(0);
    },
  };
}
