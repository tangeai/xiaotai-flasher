export const lierdaBoards = Object.freeze([
  Object.freeze({
    model: 'lite',
    slug: 'lierda-ec718pm-lite',
    aliases: ['lierda-lite'],
    firmwareKey: 'lite',
    name: 'NT26F6D0-Lite-EC718PM语音板',
    chip: 'EC718PM',
    flashBytes: 0x400000,
    modem: 'NT26F6D0',
    modempkg: 'F6D_D',
  }),
  Object.freeze({
    model: 'pro-pm',
    slug: 'lierda-ec718pm-pro',
    firmwareKey: 'pro-pm',
    name: 'NT26F6D0-Pro-EC718PM语音板',
    flashUnavailable: '此板型可查看在线固件，网页暂不支持写入外置 Flash。',
    maxPackageBytes: 0x810000,
    chip: 'EC718PM',
    flashBytes: 0x400000,
    modem: 'NT26F6D0',
    modempkg: 'F6D_D',
  }),
  Object.freeze({
    model: 'pro-f9',
    slug: 'lierda-ec718hm-pro',
    aliases: ['lierda-pro', 'lierda-pro-f9'],
    firmwareKey: 'pro',
    name: 'NT26F9D0-Pro-EC718HM视频通话板',
    chip: 'EC718HM',
    flashBytes: 0x800000,
    modem: 'NT26F9D0',
    modempkg: 'F9D_D',
  }),
]);

export function lierdaBoardForLink(slug) {
  return lierdaBoards.find(board => board.slug === slug || board.aliases?.includes(slug));
}

export function lierdaPackageSizeLimit(board) {
  return board.maxPackageBytes ?? board.flashBytes + 0x10000;
}

export function lierdaReleaseFilename(board, version) {
  return `v${version}-${board.slug}.binpkg`;
}
