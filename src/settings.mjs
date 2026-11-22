import { chips } from './chips.mjs';

export const bkWriteRates = [
  115200, 460800, 921600, 1000000, 1500000, 2000000, 3000000, 4000000, 5000000,
  6000000,
];

export const bkSettingFields = [
  [
    'bk-write-rate',
    '烧录波特率',
    bkWriteRates.map((rate) => [String(rate)]),
    '连接固定用 115200。开始烧录时切换到所选速率。2 Mbps 及以上请确认串口芯片和驱动支持，连接不稳时降低速率。',
  ],
  [
    'bk-before-reset',
    '连接前复位',
    [
      ['auto', '尝试 RTS 自动复位'],
      ['manual', '手动复位'],
    ],
    '板卡接了 RTS 时可自动复位。未接 RTS 时请选择手动，等待握手提示后按芯片复位键。',
  ],
];

export const settingFields = [
  [
    'write-rate',
    '烧录波特率',
    [['115200'], ['460800'], ['921600']],
    '下载数据的串口速率。提高速率可缩短传输时间，连接不稳定时可选 115200。',
  ],
  [
    'expected-chip',
    '目标芯片',
    [
      ['auto', '自动识别'],
      ...chips.map((name) => [name]),
    ],
    '连接时识别芯片型号。手动指定后，只有识别结果匹配才允许写入。',
  ],
  [
    'flash-mode',
    'Flash 模式',
    [
      ['keep', '保持镜像设置'],
      ['qio', 'QIO'],
      ['qout', 'QOUT'],
      ['dio', 'DIO'],
      ['dout', 'DOUT'],
    ],
    '修改可启动镜像的 SPI Flash 读写模式。保持镜像设置时沿用镜像头。',
  ],
  [
    'flash-freq',
    'Flash 时钟频率',
    [
      ['keep', '保持镜像设置'],
      ['80m', '80 MHz'],
      ['40m', '40 MHz'],
      ['26m', '26 MHz'],
      ['20m', '20 MHz'],
    ],
    '修改镜像使用的 SPI Flash 时钟。可用频率取决于芯片和开发板。',
  ],
  [
    'flash-size',
    'Flash 容量设置',
    [
      ['keep', '保持镜像设置'],
      ['detect', '自动检测'],
      ...[1, 2, 4, 8, 16, 32, 64, 128].map((size) => [
        size + 'MB',
        size + ' MB',
      ]),
    ],
    '修改启动镜像头声明的 Flash 容量。自动检测会使用设备报告的容量，手动设置需与检测结果一致。',
  ],
  [
    'before-reset',
    '连接前复位',
    [
      ['default_reset', '自动进入下载模式'],
      ['no_reset', '手动进入下载模式'],
    ],
    '自动方式尝试用串口控制信号进入下载模式。手动方式适用于已用板上按键进入下载模式的设备。',
  ],
  [
    'after-reset',
    '烧录后复位',
    [
      ['reset', '重启并运行固件'],
      ['stay', '停留在下载模式'],
    ],
    '决定写入结束后启动应用，或保留在串口 Bootloader。',
  ],
];
