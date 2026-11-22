import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { updateBootSettings, validateBootImage } from '../src/flash-image.mjs';

const bootOffset = 0x2000;
const checksumOffset = bootOffset + 47;
const digestOffset = checksumOffset + 1;
const chip = {
  IMAGE_CHIP_ID: 18,
  FLASH_SIZES: { '16MB': 0x40 },
  FLASH_FREQUENCY: { '80m': 0x0f },
};

function bootImage() {
  const image = Buffer.alloc(digestOffset + 32 + 16);
  image.set([0xe9, 1, 2, 0x30], bootOffset);
  image.writeUInt16LE(chip.IMAGE_CHIP_ID, bootOffset + 12);
  image[bootOffset + 23] = 1;
  image.writeUInt32LE(4, bootOffset + 28);
  const payload = [1, 2, 3, 4];
  image.set(payload, bootOffset + 32);
  image[checksumOffset] = payload.reduce(
    (checksum, byte) => checksum ^ byte,
    0xef,
  );
  createHash('sha256')
    .update(image.subarray(bootOffset, digestOffset))
    .digest()
    .copy(image, digestOffset);
  image.fill(0x55, digestOffset + 32);
  return image;
}

test('rewrites the boot header and digest inside a merged image', async () => {
  const original = bootImage();
  const boot = await validateBootImage(original, bootOffset, chip);
  const updated = Buffer.from(
    await updateBootSettings(
      original,
      bootOffset,
      boot,
      chip,
      {
        flashMode: 'dout',
        flashFreq: '80m',
        flashSize: 'detect',
      },
      '16MB',
    ),
  );
  assert.deepEqual(
    [...updated.subarray(bootOffset + 2, bootOffset + 4)],
    [3, 0x4f],
  );
  assert.equal(original[bootOffset + 2], 2);
  assert.deepEqual(
    updated.subarray(digestOffset + 32),
    original.subarray(digestOffset + 32),
  );
  await validateBootImage(updated, bootOffset, chip);
});

test('rejects truncated, corrupted, and incompatible boot images', async () => {
  const image = bootImage();
  await assert.rejects(
    validateBootImage(image.subarray(0, digestOffset + 8), bootOffset, chip),
    /校验失败/,
  );
  await assert.rejects(
    validateBootImage(image, bootOffset, { IMAGE_CHIP_ID: 9 }),
    /芯片型号/,
  );
  image[bootOffset + 3] ^= 1;
  await assert.rejects(validateBootImage(image, bootOffset, chip), /校验失败/);
});
