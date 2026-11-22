# 小钛在线烧录工作台

用浏览器通过 USB 串口烧录小钛或本地 ESP32 固件，并在同一页面查看设备串口日志。前端使用 React + Vite，烧录使用乐鑫 `esptool-js`。工作台按静态站点部署，板卡目录通过独立 JSON 链接维护。

## 功能

| 功能 | 说明 |
| --- | --- |
| ESP32 在线烧录 | 适用 ESP32、ESP32-S2、ESP32-S3、ESP32-C2、ESP32-C3、ESP32-C5、ESP32-C6、ESP32-H2、ESP32-P4 |
| 固件选择 | 已配置目录时默认显示小钛固件。也可导入本地完整 `.bin`。完整镜像固定从 `0x0` 写入 |
| 写入校验 | 连接后识别芯片和 Flash 容量。校验在线 BIN 的 SHA‑256 和启动镜像完整性，写入后对比设备 Flash 的 MD5 |
| 串口日志 | 独立连接运行中的设备，或在烧录结束后自动打开。可选波特率、暂停滚动、清空、复制和下载 |
| 高级设置 | 支持多 BIN 分段地址、烧录波特率、Flash 模式、频率、容量及复位方式。全片擦除默认关闭 |
| 工作台布局 | 固件和进度与日志并排显示，支持全屏，右上角可打开连接与排查 |

## 使用工作台

使用桌面版 Chrome 或 Edge 打开 HTTPS 页面。本机开发可使用 `localhost`。用可传数据的 USB 线连接开发板，关闭占用串口的工具。

1. 在「小钛固件」选择完整板卡型号和版本，或在「本地 BIN」选择适配该板卡的完整镜像。应用分区 BIN 请在「分段烧录」中按固件说明填写地址。
2. 点击「连接设备」，在浏览器弹窗选择开发板串口。核对页面检测到的芯片和 Flash 容量。
3. 点击「开始烧录」并确认固件。等进度显示「烧录完成，校验通过」。完整镜像烧录后请重新配网和绑定设备。
4. 在右侧「串口日志」查看设备运行输出。也可直接点「连接日志串口」，默认波特率为 `115200`，UART 速率需与固件设置一致。设备重启后串口变化时，重新选择日志串口。需要看最早的启动日志时，先连接日志串口，再手动复位设备。

连接失败时，打开右上角「连接与排查」，按板卡说明进入下载模式。写入不稳定时，可在高级设置中降低烧录波特率。

完整 BIN 会覆盖镜像写入范围内的扇区。需要清掉全片旧数据时，在高级设置勾选「全片擦除」。模式、时钟和容量默认沿用原镜像头。手动修改需提供对应芯片的启动镜像，工作台会重新计算其 SHA‑256。应使用板卡固件说明指定的参数。 [乐鑫 Flash 参数说明](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/flash-modes.html)

## 配置小钛固件目录

### 设置目录链接

在源码 [`public/boards-source.json`](public/boards-source.json) 填写板卡 JSON 的 HTTPS 直链或站内路径。首次用安装脚本部署时，也可以通过 `BOARDS_URL` 填写：

```json
{
  "boards_url": "https://firmware.example.com/xiaotai/boards.json"
}
```

源码自带空目录，可直接导入本地 BIN。通过安装脚本部署后，修改部署根目录下的 `boards-source.json` 并执行 `update`。独立静态托管时，可直接修改站点中的 `boards-source.json`。

### 从 GitHub Releases 生成目录

在仓库根目录运行以下命令。`scripts/generate-boards.mjs` 读取 `tangeai/xiaotai-esp32` 和 `tangeai/xiaotai` 的 Release，自动配对板卡、完整镜像和 SHA‑256。

```bash
node scripts/generate-boards.mjs --output-dir ./releases/board-catalog
```

输出包含 `boards.json` 和 `firmware/`。将两者一起发布到同一 HTTPS 目录，再把 `boards_url` 指向生成的 `boards.json`。BIN 地址使用相对路径，由目录所在站点提供下载。站点与工作台不同源时，为 JSON 和 BIN 配置 CORS。

默认收录正式版 ESP32 完整镜像。需要体验版时加 `--include-prerelease`，目录会标注体验版并优先推荐正式版。同一板型在两个仓库都有正式版时，优先推荐 `xiaotai-esp32` 的最新发布。生成器复用已经校验的 BIN，并在新目录的固件全部校验通过后替换 `boards.json`。GitHub API 限流时可提供 `GITHUB_TOKEN`。

### 板卡 JSON 格式

以下文件名、版本和摘要是示例。发布时请填写实际值，使用 `sha256sum 固件文件.bin` 可得到摘要。

```json
{
  "boards": [
    {
      "slug": "lckfb-esp32s3",
      "model": "立创·实战派 ESP32-S3",
      "chip": "ESP32-S3",
      "releases": [
        {
          "version": "1.0.0",
          "bin_url": "./firmware/lckfb-esp32s3-1.0.0-merged.bin",
          "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "status": "published",
          "recommended": true
        }
      ]
    }
  ]
}
```

- `slug` 为唯一板卡标识。后台可通过 `/web-flasher?board=lckfb-esp32s3` 预选该板。
- 每块板的 `version` 唯一。`status` 支持 `draft`、`published`、`offline`，页面仅显示 `published`。每块板最多有一个推荐版本。
- `bin_url` 指向完整 BIN，相对地址以板卡 JSON 的位置为准。`sha256` 填实际文件的 64 位十六进制摘要。
- 使用仓库自带的同源 Nginx 路由时，BIN 必须位于 `firmware/`，文件名为 `<SHA-256 小写十六进制>.bin`。生成脚本会自动采用此命名。
- JSON 和 BIN 跨域托管时，下载域名需允许工作台域名读取。例如 `Access-Control-Allow-Origin: https://xiaotai.chat`。
- 在同一个目录链接下发新版固件时，上传新 BIN 并更新板卡 JSON 即可。

## 安装和部署

目标服务器需要 Linux、Bash、Git、Node.js（20.x 至少 20.19，或 22.12 及以上）、npm、tar、`flock` 和 Nginx。服务器需要能访问 GitHub、Release 下载地址和 npm 依赖源。以下用 `/opt/xiaotai-flasher` 作为部署目录，网址为 `https://xiaotai.chat/web-flasher/`。已登录 `root` 时可省略 `sudo`。

### 1. 安装工作台和固件目录

首次安装时，把仓库克隆到部署目录下面。如果之前已经在 `/opt/xiaotai-flasher` 中执行过普通的 `git clone`，跳过这两条命令。

```bash
sudo mkdir -p /opt/xiaotai-flasher
sudo git clone https://github.com/tangeai/xiaotai-flasher.git /opt/xiaotai-flasher/xiaotai-flasher
```

直接运行仓库里的安装脚本。脚本会复用这个检出，构建工作台。安装成功后再生成正式版固件目录。

```bash
sudo env BOARDS_URL=/web-flasher/board-catalog/boards.json \
  bash /opt/xiaotai-flasher/xiaotai-flasher/scripts/install.sh &&
sudo /opt/xiaotai-flasher/deploy-prod.sh catalog
```

`BOARDS_URL` 首次安装时写入部署目录的 `boards-source.json`。已有部署要改目录链接时，编辑该文件后执行 `update`。如果脚本提示找不到 `node` 或 `npm`，先用 `sudo node --version` 和 `sudo npm --version` 检查安装用户的环境。

### 2. 配置 Nginx

复制路由片段。 [Nginx 路由片段](deploy/nginx/xiaotai-flasher.conf)

```bash
sudo install -D -m 0644 \
  /opt/xiaotai-flasher/xiaotai-flasher/deploy/nginx/xiaotai-flasher.conf \
  /etc/nginx/snippets/xiaotai-flasher.conf
```

在实际域名的 HTTPS `server` 块内加入以下配置，并确认 Nginx 已加载 `mime.types`。已有 `/web-flasher` 路由时，用此片段替换旧定义。自定义部署目录时，同步修改片段中的路径。

```nginx
include /etc/nginx/snippets/xiaotai-flasher.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 3. 上线验收

```bash
curl -fsSI 'https://xiaotai.chat/web-flasher?board=lckfb-esp32s3'
curl -fsSI https://xiaotai.chat/web-flasher/
curl -fsS https://xiaotai.chat/web-flasher/boards-source.json
curl -fsS https://xiaotai.chat/web-flasher/board-catalog/boards.json
```

首个请求应返回 `308` 并保留 `board` 参数。其余请求应返回 `200`，且板卡 JSON 中有固件记录。后台可直接链接到工作台。站点如设置了 `Permissions-Policy`，需允许同源 Web Serial。 [Web Serial 说明](https://developer.chrome.com/docs/capabilities/serial)

用桌面 Chrome 或 Edge 打开带 `board` 参数的链接，确认板卡和推荐版本预选。接一块实际设备完成连接、烧录、写入校验和复位，验证自动日志及手动连接日志。若板卡有独立的烧录和日志接口，分别选择对应串口。

### 更新与回滚

```bash
sudo /opt/xiaotai-flasher/deploy-prod.sh update
```

仅固件更新时，运行 `sudo /opt/xiaotai-flasher/deploy-prod.sh catalog`。构建成功后 `update` 会切换前端版本。需要回滚前端时，用 `/opt/xiaotai-flasher/deploy-prod.sh status` 查看版本名，再运行 `sudo /opt/xiaotai-flasher/deploy-prod.sh rollback <版本名>`。

如果 `catalog` 下载失败，先根据日志检查该 GitHub 地址，再重跑 `catalog`。脚本会重试临时网络错误，并复用已通过校验的 BIN。首次生成成功后，线上 `board-catalog/boards.json` 才能返回 `200`。

## 本地开发

```bash
npm ci
npm run dev      # http://localhost:5173/
```

执行 `npm run build` 生成 `dist/`，再用 `npm run preview` 检查构建结果。
执行 `npm test` 可验证启动镜像校验与 Flash 参数修改。
