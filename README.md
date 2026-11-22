# 小钛在线烧录工作台

用浏览器通过 USB 串口烧录小钛或本地 ESP32、BK7258、EC718PM 固件，并在同一页面查看设备串口日志。前端使用 React + Vite，ESP32 烧录使用乐鑫 `esptool-js`，BK7258 使用 Beken UART 下载协议。工作台按静态站点部署，板卡目录通过独立 JSON 链接维护。

## 功能

| 功能 | 说明 |
| --- | --- |
| ESP32 在线烧录 | 适用 ESP32、ESP32-S2、ESP32-S3、ESP32-C2、ESP32-C3、ESP32-C5、ESP32-C6、ESP32-H2、ESP32-P4 |
| BK7258 在线烧录 | 支持原始 `all-app.bin` 从 `0x0` 写入，烧录后读取 Flash CRC 校验 |
| EC718 在线烧录 | 支持 Air780EPM 的 `.binpkg`，通过原生 USB BOOT 写入 BL、AP、CP 分区，并读取运行模式下的 SOC 串口日志 |
| 固件选择 | 已配置目录时默认显示小钛固件。也可导入本地完整 `.bin`。ESP32 和 BK7258 的完整 BIN 从 `0x0` 写入 |
| 写入校验 | 校验在线 BIN 的 SHA‑256。ESP32 写入后对比 Flash 的 MD5，BK7258 写入后对比 Flash 的 CRC |
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

ESP32 完整 BIN 会覆盖镜像写入范围内的扇区。需要清掉全片旧数据时，在高级设置勾选「全片擦除」。模式、时钟和容量默认沿用原镜像头。手动修改需提供对应芯片的启动镜像，工作台会重新计算其 SHA‑256。应使用板卡固件说明指定的参数。 [乐鑫 Flash 参数说明](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/flash-modes.html)

### BK7258 烧录和看日志

1. 将开发板的下载串口 `DL_UART0` 接到电脑，在工作台选择 **BK7258**。选择对应板型的在线版本，或导入板卡原始 `all-app.bin`。
2. 点「连接设备」并选择 UART0。页面显示等待连接后，按复位键或保持串口连线并重新给开发板上电。握手成功后点「开始烧录」。
3. 等待写入和 CRC 校验完成。串口日志沿用同一工作台，UART0 默认 `115200`。要看最早的启动日志，可以先连接日志串口，再手动复位。

本分支支持小钛立创和觅感 8 MiB Flash 板型使用的原始镜像布局。OTA 文件、安全下载包、分段地址、整片擦除和其他 BK 芯片暂未开放。Flash 型号无法识别时会停止烧录。 [Beken BK7258 开发指南](https://docs.riselink.ai/arminodoc/bk_avdk_smp/smp_doc/bk7258/en/v3.1.1/get-started/index.html#burn-code) · [小钛板型说明](https://github.com/tangeai/xiaotai#选择开发板和固件)

### EC718PM（Air780EPM）烧录和看日志

1. 确认模组型号为 **Air780EPM**。用可传数据的 USB 线连接模组的原生 USB 口。按住 BOOT 键复位或重新上电，松开后在工作台选择 **EC718PM（Air780EPM）**，点「连接 USB BOOT」。选择新出现的下载口（VID:PID `17D1:0001`）。该 USB 标识也用于其他移芯模组，工作台按所选板型限制固件，板型请以设备丝印为准。
2. 选择在线版本，或用 7-Zip 打开合宙的 `.soc`，从包中的 `info.json` 查看 `rom.file` 并提取对应的 `.binpkg`。本地烧录同时选择 `ec718m_usb.bin`（50788 字节）。AgentBoot 校验后仅加载到模组 RAM。 [合宙固件版本](https://docs.openluat.com/air780epm/luatos/firmware/780epm_version/) · [AgentBoot 文件](https://media.githubusercontent.com/media/wendal/luatos-cli/62aa4ed4f44f5860137fb90fb3998ce401546d71/refs/origin_tools/ec_download/agentboot/ec718m_usb.bin)
3. 点「开始烧录」，确认包内的 BL、AP、CP 分区将被覆盖。工作台按包内地址写入并检查各分区烧录状态。当前流程使用 Air780EPM 核心固件包，Lua 脚本和文件系统镜像请使用合宙工具单独管理。
4. 设备重启后点「连接日志串口」，选择运行模式的 **SOC 日志口**（VID:PID `19D1:0001`、USB 接口 `x.2`、速率 `921600`）。有多个同名端口时，在系统设备管理器中核对接口编号。工作台解码该口的 LuatOS 日志帧，支持暂停滚动、复制和下载。

[合宙 Air780EPM 下载接口说明](https://docs.openluat.com/air780epm/luatos/hardware/download/) · [LuatOS CLI 下载与日志协议](https://github.com/wendal/luatos-cli/blob/main/docs/ec718-flash-protocol.md)

## 配置小钛固件目录

### 设置目录链接

在源码 [`public/boards-source.json`](public/boards-source.json) 填写板卡 JSON 的 HTTPS 直链或站内路径。首次用安装脚本部署时，也可以通过 `BOARDS_URL` 填写：

```json
{
  "boards_url": "https://firmware.example.com/xiaotai/boards.json"
}
```

源码自带空目录，可直接导入本地 BIN。通过安装脚本部署后，修改部署根目录下的 `boards-source.json` 并执行 `update`。独立静态托管时，可直接修改站点中的 `boards-source.json`。

### 手动上传新固件

1. 用 `sha256sum 新固件.bin` 计算摘要，将适配该板型、从 `0x0` 写入的完整 BIN 以 `<摘要>.bin` 的文件名上传到服务器的 `/opt/xiaotai-flasher/board-catalog/firmware/`。BK7258 需使用原始 `all-app.bin`。
2. 在仓库根目录的 [`boards.json`](boards.json) 对应板型下添加版本。`bin_url` 填 `./firmware/<摘要>.bin`，`sha256` 填相同摘要。设为推荐版本时，去掉同一板型旧版本的 `recommended: true`。运行 `npm test` 检查格式和下载路径。
3. BIN 可下载后，将更新后的 `boards.json` 上传到 `/opt/xiaotai-flasher/board-catalog/boards.json`，刷新页面确认新版本。前端无需重新构建。由人工维护目录时，避免运行会重新生成目录的 `catalog` 命令。

EC718PM 版本手动配置。板卡的 `chip` 填 `EC718PM`，可将 `.binpkg` 以 `<摘要>.binpkg` 的文件名上传到同一 `firmware/` 目录，在现有版本结构中填写：

```json
{
  "version": "V2029",
  "bin_url": "./firmware/<固件包的 SHA-256>.binpkg",
  "sha256": "<固件包的 SHA-256>",
  "agent_url": "./firmware/0db9e8f3462140c7c368723aa144b976ac033ae45fc6d37db5d959b1c9238019.bin",
  "status": "published"
}
```

`agent_url` 指向已获分发许可的匹配 AgentBoot，省略时工作台提示用户本地选择。已有 Nginx 部署需更新路由片段并重载，才能从 `firmware/` 下载 `.binpkg`。

### 从 GitHub Releases 生成目录

在仓库根目录运行以下命令。`scripts/generate-boards.mjs` 读取 `tangeai/xiaotai-esp32` 和 `tangeai/xiaotai` 的 Release，自动配对板卡、完整镜像和 SHA‑256。

```bash
node scripts/generate-boards.mjs --output-dir ./releases/board-catalog
```

输出包含 `boards.json` 和 `firmware/`。将两者一起发布到同一 HTTPS 目录，再把 `boards_url` 指向生成的 `boards.json`。BIN 地址使用相对路径，由目录所在站点提供下载。站点与工作台不同源时，为 JSON 和 BIN 配置 CORS。

默认收录正式版 ESP32 完整镜像和 BK7258 原始 `all-app.bin`。需要体验版时加 `--include-prerelease`，目录会标注体验版并优先推荐正式版。同一板型在两个仓库都有正式版时，优先推荐 `xiaotai-esp32` 的最新发布。生成器复用已经校验的 BIN，并在新目录的固件全部校验通过后替换 `boards.json`。GitHub API 限流时可提供 `GITHUB_TOKEN`。

### 板卡 JSON 格式

以下是当前立创开发板的一条记录。添加版本时填入新 BIN 的实际摘要。

```json
{
  "boards": [
    {
      "slug": "lckfb-esp32s3",
      "model": "立创·实战派 ESP32-S3",
      "chip": "ESP32-S3",
      "releases": [
        {
          "version": "v0.3.0 · xiaotai-esp32",
          "bin_url": "./firmware/b368c59e5c300b9b7f021baa1c66aa34c1a12b5e00d6e2529f1dabd0a2ef3159.bin",
          "sha256": "b368c59e5c300b9b7f021baa1c66aa34c1a12b5e00d6e2529f1dabd0a2ef3159",
          "status": "published",
          "recommended": true
        }
      ]
    }
  ]
}
```

- `slug` 为唯一板卡标识。后台可通过 `/web-flasher?board=lckfb-esp32s3` 预选该板。
- 可用 `flash_bytes` 声明要求的 Flash 容量。声明后，设备检测到的容量必须一致。
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

直接运行仓库里的安装脚本。脚本会复用这个检出，构建工作台。

```bash
sudo env BOARDS_URL=/web-flasher/board-catalog/boards.json \
  bash /opt/xiaotai-flasher/xiaotai-flasher/scripts/install.sh
```

安装成功后，按[手动上传新固件](#手动上传新固件)放置 BIN 和目录文件，或用 `sudo /opt/xiaotai-flasher/deploy-prod.sh catalog` 从 GitHub 生成正式版目录。

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

仅固件更新时，沿用已选的目录维护方式。构建成功后 `update` 会切换前端版本。需要回滚前端时，用 `/opt/xiaotai-flasher/deploy-prod.sh status` 查看版本名，再运行 `sudo /opt/xiaotai-flasher/deploy-prod.sh rollback <版本名>`。

如果 `catalog` 下载失败，先根据日志检查该 GitHub 地址，再重跑 `catalog`。Release 附件通常会跳转到 `release-assets.githubusercontent.com`，服务器也需要能访问该域名。首次上线可以先生成正式版目录，再加 `--include-prerelease` 更新体验版。脚本会重试临时网络错误，并复用已校验的 BIN。

## 本地开发

```bash
npm ci
npm run dev      # http://localhost:5173/
```

执行 `npm run build` 生成 `dist/`，再用 `npm run preview` 检查构建结果。
执行 `npm test` 可验证固件目录、镜像校验、ESP32 Flash 参数，以及 BK7258、EC718 的模拟串口流程。
