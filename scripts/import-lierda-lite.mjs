import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { importLierdaLiteCatalog } from './import-lierda.mjs';

export { importLierdaLiteCatalog };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'output-dir': { type: 'string' } } });
    if (!values['output-dir']?.trim()) throw new Error('请通过 --output-dir 指定 Lite 固件目录。');
    const catalog = await importLierdaLiteCatalog(resolve(values['output-dir']));
    console.log(catalog ? `已更新 ${catalog.releases.length} 个 Lite 固件版本。` : '尚无 lite-v 发布，保留当前 Lite 固件目录。');
  } catch (error) {
    console.error('[ERROR] ' + error.message);
    process.exitCode = 1;
  }
}
