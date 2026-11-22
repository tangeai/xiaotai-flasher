import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const releaseNamePattern = /^xiaotai-flasher-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]+$/;

function deployment(path, create = false) {
  const destination = resolve(path);
  const parentPath = dirname(destination);
  if (parentPath === destination) throw new Error('部署路径不能是文件系统根目录。');
  if (create) mkdirSync(parentPath, { recursive: true });
  const parent = existsSync(parentPath) ? realpathSync(parentPath) : parentPath;
  const name = basename(destination);
  const target = join(parent, name);
  const versions = join(parent, '.' + name + '-releases');
  const versionStorage = lstatSync(versions, { throwIfNoEntry: false });
  if (versionStorage && !versionStorage.isDirectory()) throw new Error('版本存储路径必须是普通目录。');

  const existing = lstatSync(target, { throwIfNoEntry: false });
  let current;
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error('部署路径已有文件或目录。请选择空闲路径创建发布链接。');
    current = resolve(parent, readlinkSync(target));
    if (dirname(current) !== versions || !releaseNamePattern.test(basename(current)) ||
        !lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('部署路径不是此脚本管理的发布链接。');
    }
  }
  return { parent, name, target, versions, current };
}

function activate(site, releaseName) {
  const temporary = mkdtempSync(join(site.parent, '.' + site.name + '-switch-'));
  try {
    const link = join(temporary, 'next');
    symlinkSync(join(basename(site.versions), releaseName), link);
    renameSync(link, site.target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function copyCurrentAssets(site, candidate) {
  if (site.current && existsSync(join(site.current, 'assets'))) {
    cpSync(join(site.current, 'assets'), join(candidate, 'assets'), { recursive: true, force: false });
  }
}

function publish(site, releaseName, source) {
  if (!releaseNamePattern.test(releaseName)) throw new Error('无效的发布版本目录名。');
  if (!completeRelease(source)) throw new Error('静态产物不完整。');
  mkdirSync(site.versions, { recursive: true });
  const candidate = join(site.versions, releaseName);
  mkdirSync(candidate);
  let installed = false;
  try {
    chmodSync(candidate, 0o755);
    copyCurrentAssets(site, candidate);
    cpSync(source, candidate, { recursive: true });
    activate(site, releaseName);
    installed = true;
  } finally {
    if (!installed) rmSync(candidate, { recursive: true, force: true });
  }
  console.log('[INFO] 发布路径 ' + site.target);
  if (site.current) console.log('[INFO] 上一版本 ' + basename(site.current));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readReleaseInfo(current) {
  const path = join(current, 'release-info.json');
  return existsSync(path) ? readJSON(path) : {};
}

function completeRelease(path) {
  const index = join(path, 'index.html');
  const options = { throwIfNoEntry: false };
  if (
    !lstatSync(join(path, 'boards-source.json'), options)?.isFile() ||
    !lstatSync(join(path, 'assets'), options)?.isDirectory() ||
    !lstatSync(index, options)?.isFile()
  ) {
    return false;
  }

  const assetTags = readFileSync(index, 'utf8').matchAll(
    /<(?:script|link)\b[^>]*\b(?:src|href)=["']\.\/(assets\/[\w.-]+)["']/g,
  );
  const assets = Array.from(assetTags, ([, asset]) => asset);
  return assets.some((asset) => asset.endsWith('.js')) && assets.every((asset) => {
    const file = lstatSync(join(path, asset), options);
    return file?.isFile() && file.size > 0;
  });
}

function displayStatus(site) {
  console.log('[INFO] 部署路径 ' + site.target);
  if (!site.current) {
    console.log('[INFO] 尚未发布');
    return;
  }
  console.log('[INFO] 当前版本 ' + basename(site.current));
  console.log('[INFO] 源码提交 ' + (readReleaseInfo(site.current).commit || '未记录'));
  console.log('[INFO] 板卡目录 ' + readJSON(join(site.current, 'boards-source.json')).boards_url);
  const versions = readdirSync(site.versions, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() && releaseNamePattern.test(entry.name) &&
      completeRelease(join(site.versions, entry.name)))
    .map((entry) => entry.name)
    .sort().reverse();
  console.log('[INFO] 可用版本\n' + versions.join('\n'));
}

function rollback(site, releaseName) {
  if (!releaseNamePattern.test(releaseName)) throw new Error('请传入 status 显示的版本目录名。');
  if (!site.current) throw new Error('尚未部署工作台，无法切换版本。');
  const candidate = join(site.versions, releaseName);
  if (!lstatSync(candidate, { throwIfNoEntry: false })?.isDirectory() || !completeRelease(candidate)) {
    throw new Error('指定版本不存在或静态产物不完整。');
  }
  if (candidate !== site.current) {
    copyCurrentAssets(site, candidate);
    activate(site, releaseName);
  }
  console.log('[INFO] 当前版本 ' + releaseName);
}

function matches(site, commit, boardsUrl) {
  return site.current && completeRelease(site.current) &&
    readReleaseInfo(site.current).commit === commit &&
    readJSON(join(site.current, 'boards-source.json')).boards_url === boardsUrl;
}

const [command, path, ...args] = process.argv.slice(2);
try {
  if (command === 'verify') process.exit(completeRelease(resolve(path)) ? 0 : 1);
  const site = deployment(path, command === 'publish');
  switch (command) {
    case 'publish': publish(site, ...args); break;
    case 'status': displayStatus(site); break;
    case 'matches': process.exitCode = matches(site, ...args) ? 0 : 1; break;
    case 'rollback': rollback(site, ...args); break;
    default: throw new Error('未知发布操作：' + command);
  }
} catch (error) {
  console.error('[ERROR] ' + error.message);
  process.exitCode = 2;
}
