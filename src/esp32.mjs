import { LocalizedError } from './i18n.mjs';
import { chips } from './chips.mjs';
import SparkMD5 from 'spark-md5';
import { ESPLoader, Transport } from './vendor/esptool-0.7.0.mjs';
import {
  updateBootSettings,
  validateBootImage,
  validateCompleteImage,
  validateLayout,
} from './flash-image.mjs';

export async function connectEsp32(port, settings, print) {
  const transport = new Transport(port);
  const loader = new ESPLoader({
    transport,
    baudrate: settings.baudrate,
    terminal: {
      clean() {},
      writeLine: (line) => print(line + '\n'),
      write: print,
    },
  });
  const close = async () => {
    if (port.readable || port.writable) await transport.disconnect();
  };
  try {
    const description = await loader.main(settings.before);
    const chip = loader.chip;
    if (!chips.includes(chip.CHIP_NAME))
      throw new LocalizedError('请选择 ESP32 系列设备的串口。');
    if (loader.secureDownloadMode)
      throw new LocalizedError('设备处于安全下载模式，请使用与设备配套的烧录流程。');
    const detected = await loader.detectFlashSize();
    const capacity = detected && loader.flashSizeBytes(detected);
    if (!(capacity > 0))
      throw new LocalizedError('无法识别 Flash 容量，请检查设备后重连。');
    return {
      chip: chip.CHIP_NAME,
      description,
      capacity,
      capacityLabel: detected,
      close,
      reset: () => loader.after('hard_reset'),
      async write(images, options, progress) {
        validateLayout(images, capacity);
        if (options.eraseAll && !loader.IS_STUB)
          throw new LocalizedError('当前设备连接方式无法执行全片擦除。');
        const overrides = [
          options.flashMode,
          options.flashFreq,
          options.flashSize,
        ].some((value) => value !== 'keep');
        if (
          options.flashSize !== 'keep' &&
          options.flashSize !== 'detect' &&
          loader.flashSizeBytes(options.flashSize) !== capacity
        ) {
          throw new LocalizedError('所选 Flash 容量与设备检测结果不一致。');
        }
        let bootFound = false;
        const fileArray = [];
        for (const image of images) {
          const bootOffset = chip.BOOTLOADER_FLASH_OFFSET - image.address;
          let data = image.data;
          if (
            options.complete ||
            (bootOffset >= 0 && bootOffset < image.data.byteLength)
          ) {
            const boot = await validateBootImage(data, bootOffset, chip);
            if (options.complete)
              await validateCompleteImage(data, boot, chip, capacity);
            bootFound = true;
            if (overrides)
              data = await updateBootSettings(
                data,
                bootOffset,
                boot,
                chip,
                options,
                detected,
              );
          }
          fileArray.push({ ...image, data });
        }
        if (overrides && !bootFound)
          throw new LocalizedError('修改 Flash 参数时，请同时提供启动镜像。');
        const totalSize = images.reduce(
          (total, image) => total + image.size,
          0,
        );
        const starts = [];
        images.reduce((total, image) => {
          starts.push(total);
          return total + image.size;
        }, 0);
        await loader.writeFlash({
          ...options,
          flashMode: 'keep',
          flashFreq: 'keep',
          flashSize: 'keep',
          fileArray,
          calculateMD5Hash: (data) =>
            SparkMD5.ArrayBuffer.hash(
              data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength,
              ),
            ),
          reportProgress: (index, written, total) => {
            if (total > 0)
              progress(
                (starts[index] +
                  images[index].size * Math.min(written / total, 1)) /
                  totalSize,
              );
          },
        });
      },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
