import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export function useSyntheticAgent(t, pinnedHashes = new Map()) {
  // The vendor binary is supplied at deployment. Stub its pinned digest only;
  // the ROM transfer, LPC frames and Flash sample hashes use the normal code.
  const agent = new Uint8Array(50032);
  t.mock.method(globalThis, 'fetch', async () => new Response(agent));
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, data) => {
    if (data.byteLength === agent.length) {
      return Uint8Array.from(Buffer.from('045bd0c74a030143230f07484e4711600005b992e3b0776be042e42d141a38e5', 'hex')).buffer;
    }
    if (pinnedHashes.size) {
      const pinned = pinnedHashes.get(createHash('sha256').update(data instanceof ArrayBuffer ? new Uint8Array(data) : data).digest('hex'));
      if (pinned) return Uint8Array.from(Buffer.from(pinned, 'hex')).buffer;
    }
    return digest(algorithm, data);
  });
}

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

export function lpcWire(respond) {
  let pending = Buffer.alloc(0);
  return {
    discardBufferedInput() {},
    async write(bytes) {
      const request = Buffer.from(bytes);
      if (request.length === 4) { pending = request; return; }
      const { data, status = 0, size = data.length, damage = false } = respond(request);
      const header = Buffer.concat([request.subarray(0, 4), Buffer.from([status, size])]);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32LE(crc32(data, crc32(header)));
      if (damage) checksum[0] ^= 1;
      pending = Buffer.concat([header, data, checksum]);
    },
    async readExactly(size) {
      assert.ok(size <= pending.length);
      const part = pending.subarray(0, size);
      pending = pending.subarray(size);
      return part;
    },
  };
}

// Without a Flash simulator the LPC stage only accepts READ_MEM.
export function downloadPort(sample, { romVersion = '0000030301000000', corruptRead = false, slow = false, stallAgent, stallDetection, flash } = {}) {
  let nextImage = 0x54494d48;
  let ramAgentReady = false;
  let romImage;
  let ramAgent;
  let repliedToSync = false;
  const reads = [];
  const agentBauds = [];
  const commands = [];
  const port = {
    getInfo: () => ({ usbVendorId: 0x17d1, usbProductId: 0x0001 }),
    connected: true, reads, agentBauds, commands,
    chipInfo: Buffer.concat([Buffer.from('ec718m2'), Buffer.alloc(25)]),
    get ramAgent() { return ramAgent; },
    async setSignals() {},
    async open({ baudRate }) {
      repliedToSync = false;
      this.openedBaud = baudRate;
      let device;
      this.readable = new ReadableStream({ start(controller) { device = controller; } });
      this.writable = new WritableStream({ async write(bytes, controller) {
        const frame = Buffer.from(bytes);
        if (frame.length === 4) {
          // A resident agent either ignores DLBOOT or answers with a non-ROM marker.
          if (ramAgentReady && frame[0] === 0) {
            if (port.residentRomReply) {
              if (!repliedToSync) device.enqueue(port.residentRomReply);
              repliedToSync = !repliedToSync;
            }
            return;
          }
          if (!repliedToSync) device.enqueue(Buffer.concat([frame, Buffer.of(0)]));
          repliedToSync = !repliedToSync;
          return;
        }
        repliedToSync = false;
        commands.push(frame[0]);
        const header = Buffer.from(frame.subarray(0, 4));
        if (flash && (frame[2] === 0x4c || flash.programming)) {
          let payload;
          if (frame[2] === 0x4c && frame[0] === 0x21) {
            const address = frame.readUInt32LE(12);
            reads.push(address);
            if (address >= 0x401000 && address < 0x401000 + ramAgent.length) {
              const offset = address - 0x401000;
              payload = ramAgent.subarray(offset, offset + frame.readUInt32LE(8));
            } else if (address === 0xe0000000) {
              assert.equal(frame.toString('hex'), '21004cb30800002520000000000000e04395097b');
              payload = port.chipInfo;
            }
          }
          payload ??= flash.reply(frame);
          if (frame[2] !== 0x4c && frame[0] === 0x32) header[1] = (header[1] + 1) & 0xff;
          const length = frame[2] === 0x4c && frame[0] === 0x24 ? 0xfa : payload.length;
          const reply = Buffer.concat([header, Buffer.of(0, length), payload]);
          device.enqueue(Buffer.concat([reply, uint32(crc32(reply))]));
          return;
        }
        if (frame[2] === 0x4c) {
          assert.equal(frame[0], 0x21);
          reads.push(frame.readUInt32LE(12));
          assert.equal(frame.readUInt32LE(8), sample.length);
          if (stallDetection) {
            stallDetection.resolve();
            return;
          }
          const reply = Buffer.concat([header, Buffer.of(0, sample.length), sample]);
          device.enqueue(reply.subarray(0, 6));
          const payload = Buffer.concat([sample, uint32(corruptRead ? 0 : crc32(reply))]);
          if (slow) setTimeout(() => device.enqueue(payload), 1100);
          else device.enqueue(payload);
          return;
        }
        let payload = Buffer.alloc(0);
        switch (frame[0]) {
          case 0x20: payload = Buffer.from(romVersion, 'hex'); break;
          case 0x21:
            romImage = nextImage;
            payload = uint32(romImage);
            nextImage = 0x4f424d49;
            break;
          case 0x31: payload = frame.subarray(8, 12); break;
          case 0x32:
            header[1]++;
            if (romImage === 0x4f424d49) ramAgent = Buffer.from(frame.subarray(8, 8 + frame.readUIntLE(4, 3)));
            if (frame.readUInt32LE(4) === 272) agentBauds.push(frame.readUInt16LE(8 + 22));
            if (stallAgent && frame.length > 50000) {
              stallAgent.resolve(controller.signal);
              await new Promise(done => controller.signal.addEventListener('abort', done, { once: true }));
              return;
            }
            if (slow && frame.length > 50000) await new Promise(resolve => setTimeout(resolve, 3100));
            break;
          case 0x22: break;
          case 0x3a:
            if (romImage === 0x4f424d49) ramAgentReady = true;
            break;
          default: assert.fail('Unexpected boot command ' + frame[0]);
        }
        device.enqueue(Buffer.concat([header, Buffer.of(0, payload.length), payload]));
      } });
    },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      this.readable = this.writable = null;
    },
  };
  return port;
}
