# 小钛固件烧录与串口日志工作台

用浏览器通过 USB 串口烧录 ESP32、BK7258 和利尔达（移芯）开发板，并在同一页面查看设备串口日志。工作台按静态站点部署，各平台共用板卡目录，可选择已发布的固件或本地文件。

## 功能

| 功能 | 说明 |
| --- | --- |
| ESP32 在线烧录 | 适用 ESP32、ESP32-S2、ESP32-S3、ESP32-C2、ESP32-C3、ESP32-C5、ESP32-C6、ESP32-H2、ESP32-P4 |
| BK7258 在线烧录 | 支持原始 `all-app.bin` 从 `0x0` 写入，烧录后读取 Flash CRC 校验 |
| 利尔达固件 | 按开发板和版本选择 BINPKG，EC718PM Lite 与 EC718HM Pro 支持网页烧录，EC718PM Pro 可浏览版本 |
| 固件选择 | 已配置目录时默认显示小钛固件。也可导入本地完整 BIN 或利尔达 BINPKG。ESP32 和 BK7258 的完整 BIN 从 `0x0` 写入 |
| 写入校验 | 校验在线 BIN 的 SHA‑256。ESP32 写入后对比 Flash 的 MD5，BK7258 写入后对比 Flash 的 CRC |
| 串口日志 | 独立连接运行中的设备，或在烧录结束后自动打开。可发送文本指令、选择行尾、调整波特率、暂停滚动、清空、复制、下载和持续记录到本地文件夹 |
| 高级设置 | 支持多 BIN 分段地址、烧录波特率、Flash 模式、频率、容量及复位方式。全片擦除默认关闭 |
| 工作台布局 | 桌面可拖动两栏之间的分隔线调整固件面板宽度，刷新页面或双击分隔线恢复默认，支持全屏，右上角可打开 FAQ |

## 使用工作台

桌面布局最低目标屏幕分辨率为 1920×1080，另覆盖 1920×1200。浏览器缩放或分屏时，工具栏按面板实际宽度换行。

使用桌面版 Chrome 或 Edge 打开 HTTPS 页面。本机开发可使用 `localhost`。用可传数据的 USB 线连接开发板，关闭占用串口的工具。

1. 在「小钛固件」选择完整板卡型号和版本，或在「本地 BIN」选择适配该板卡的完整镜像。应用分区 BIN 请在「分段烧录」中按固件说明填写地址。
2. 点击「连接设备」，在浏览器弹窗选择开发板串口。核对页面检测到的芯片和 Flash 容量。
3. 点击「开始烧录」并确认固件。等进度显示「烧录完成，校验通过」。完整镜像烧录后请重新配网和绑定设备。
4. 在右侧「串口日志」查看设备运行输出。也可直接点「连接日志串口」，默认波特率为 `115200`，UART 速率需与固件设置一致。设备重启后串口变化时，重新选择日志串口。需要看最早的启动日志时，先连接日志串口，再手动复位设备。

ESP32 和 BK7258 均可通过已连接的日志串口向运行中的固件发送文本指令。在日志窗口下方输入固件支持的指令，按 Enter 或点击「发送指令」。文本按 UTF-8 编码，默认追加 CR+LF；也可按固件控制台要求选择 LF、CR 或无行尾。需要发送原始字节时，切换到 HEX，输入 `AA 01 FF` 或 `AA01FF`。HEX 只发送指定字节，协议需要的行尾可直接填写 `0D 0A`。设备的文本回显和回复会出现在串口日志中。BK7258 请连接固件实际使用的交互控制台接口。

ESP32 固件开放物理 AT 时，连接主控制台后可点「测试 AT」。工作台会发送一次 `AT` 加回车，收到独立一行 `OK` 即提示设备已响应。如果控制台回复 `Unrecognized command`，说明串口收发正常，可按控制台提示发送 `help` 查看可用命令。3 秒内无回包会提示检查接口、波特率和固件配置。

在指令框中按 ↑ / ↓ 可调出本次连接最近成功发送的 50 条不同指令，连同格式和行尾一起恢复。按 ↓ 越过最新一条会回到原来的草稿。

串口预览最多保留最近 1000 行、24 万个字符，先达到哪项上限就从最早的内容开始裁剪。持续记录到文件夹可保留更早的设备输出。

点击日志旁的放大镜，或在日志区按 Ctrl+F（macOS 为 ⌘F），可在当前缓存中查找文本。Enter / Shift+Enter 切换下一处或上一处，Esc 收起。查找期间继续接收和记录日志，关闭后恢复原来的滚动设置。

勾选「时间」，每行前会显示浏览器收到该行首个字符的本地时间，例如 `[09:05:08.007]`。开关对当前已缓存的日志也生效。「复制日志」和「下载日志」使用当前显示格式，「记录到文件夹」始终保存设备输出原文。

长时间采集时，在桌面 Chrome 或 Edge 中连接日志串口，点「记录到文件夹」并选择保存位置。从选好目录起，新收到的日志按 UTF-8 写入。文件名使用本地开始时间和分卷序号，例如 `20261123090508-001.log`。每份约 10 MiB，后续分卷沿用开始时间，遇到同名文件会跳到下一个可用序号。清空屏幕或关闭自动滚动都不影响文件。页面每 30 秒或累计约 26 万个字符时提交一次，点「停止记录」或断开串口会保存剩余内容。关闭页面前请先停止记录，避免丢失尚未提交的日志。

若提示写入速度跟不上，串口窗口会继续显示输出，工作台会尝试写完已缓存的记录。等「记录到文件夹」按钮恢复后，可选择较快的本地目录重新开始。若正在写入的分卷被其他软件改动了大小，工作台会停止记录并提示原因。

连接失败时，打开右上角「FAQ」，按板卡说明进入下载模式。写入不稳定时，可在高级设置中降低烧录波特率。

ESP32 完整 BIN 写入前会检查启动镜像、分区表及对应芯片的应用镜像，再校验写入结果。完整 BIN 会覆盖镜像写入范围内的扇区。需要清掉全片旧数据时，在高级设置勾选「全片擦除」。模式、时钟和容量默认沿用原镜像头。手动修改需提供对应芯片的启动镜像，工作台会重新计算其 SHA‑256。应使用板卡固件说明指定的参数。 [乐鑫 Flash 参数说明](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/flash-modes.html)

### BK7258 烧录和看日志

1. 将开发板的下载串口 `DL_UART0` 接到电脑，在工作台选择 **博通集成 Beken（BK7258）**。选择对应板型的在线版本，或导入板卡原始 `all-app.bin`。
2. 点「连接设备」，在浏览器中选择开发板对应的 USB 串口。列表里可能显示 USB 转串口芯片名称或系统端口号，例如 CH340 或 COM3。看到「等待下载握手」时，**在 15 秒内按一下板上的 RESET 键**。若已自动连接，可跳过按键。看到「下载串口已就绪」后点「开始烧录」，擦写期间请勿复位。
3. 在「高级设置」可选烧录波特率。握手使用 `115200`，擦写前会确认通信速率。高速握手超时后，工作台会尝试回到原速率；重新握手并核对芯片 ID 和 Flash JEDEC 后可继续烧录。工作台默认保留 `115200`，更高速率取决于串口芯片与驱动支持。烧录失败后可调整波特率，再点「重新连接」复用同一串口。串口日志波特率独立设置，UART0 默认为 `115200`。要看最早的启动日志，可以先连接日志串口，再手动复位。

本分支支持小钛立创和觅感 8 MiB Flash 板型使用的原始镜像布局。OTA 文件、安全下载包、分段地址、整片擦除和其他 BK 芯片暂未开放。Flash 型号无法识别时会停止烧录。 [Beken BK7258 开发指南](https://docs.riselink.ai/arminodoc/bk_avdk_smp/smp_doc/bk7258/en/v3.1.1/get-started/index.html#burn-code) · [小钛板型说明](https://github.com/tangeai/xiaotai#选择开发板和固件)

## 板卡和浏览器兼容性记录

| 板卡和接口 | 环境 | 已验证结果 |
| --- | --- | --- |
| 立创·实战派 BK7258，CH340K（`1A86:7522`），Flash JEDEC `0x1765C8` | Windows，Chromium 系浏览器，具体版本未记录 | 用户实板确认 `2000000` 烧录和 CRC 校验通过。日志使用 `115200`。打开日志曾使板卡黑屏，打开后释放 RTS/DTR 恢复。 |
| 立创·实战派 BK7258，CH340K（COM19） | Windows，BKFIL `4.1.7.261014250` | 用户截图显示 `build.101` 镜像在 `2000000` 下已进入 Flash 写入。 |
| ESP32，常见 USB 转 UART 桥和原生 USB | Chromium 模拟串口 | 已回归日志中的控制线处理。USB 转 UART 板卡的实际复位行为取决于 RTS/DTR 接线，待实板核对。 |
| macOS 上的 Chrome / Edge | Chromium 源码核对 | 串口驱动和高速波特率设置路径与 Windows 不同。RTS/DTR 和 `2000000` 的结果待实板确认。 |

日志串口打开后，BK7258 和可识别的 ESP32 USB 转 UART 桥先监听 400 ms。有串口数据时保持控制线状态，静默时尝试释放 RTS/DTR 一次。浏览器授权弹窗由系统可见的接口和网页端口过滤条件共同决定。 [Chromium Windows 串口实现](https://github.com/chromium/chromium/blob/main/services/device/serial/serial_io_handler_win.cc#L231) · [Chromium macOS 串口实现](https://github.com/chromium/chromium/blob/main/services/device/serial/serial_io_handler_posix.cc#L148)

## 配置小钛固件目录

### 设置目录链接

在源码 [`public/boards-source.json`](public/boards-source.json) 填写板卡 JSON 的 HTTPS 直链或站内路径。首次用安装脚本部署时，也可以通过 `BOARDS_URL` 填写：

```json
{
  "boards_url": "https://firmware.example.com/xiaotai/boards.json"
}
```

源码自带空目录，可直接导入本地固件。通过安装脚本部署后，修改部署根目录下的 `boards-source.json` 并执行 `update`。独立静态托管时，可直接修改站点中的 `boards-source.json`。

### 手动上传新固件

如果旧部署没有固件目录，先运行 `sudo mkdir -p /opt/xiaotai-flasher/board-catalog/firmware`。

1. 用 `sha256sum` 计算摘要，将固件放入服务器的 `/opt/xiaotai-flasher/board-catalog/firmware/`。ESP32 使用从 `0x0` 写入的完整 BIN，BK7258 使用原始 `all-app.bin`，均保留附件原名。利尔达使用完整 BINPKG，可保留发布附件名 `v<版本号>-<板型标识>.binpkg`，也可使用带摘要的存储名 `<板型键>-v<版本号>-<SHA-256>.binpkg`，PM Lite、PM Pro、HM Pro 分别使用 `lite`、`pro-pm`、`pro`。
2. 参照 [`boards.json`](boards.json) 在对应板型下添加版本。`bin_url` 填 `./firmware/<存储文件名>`，`sha256` 填实际摘要。利尔达另填 `source_filename`（附件原名）和 `byte_length`。每块板只标记一个推荐版本。运行 `npm test` 检查格式和下载路径。
3. 确认固件可下载后，将更新后的 `boards.json` 上传到 `/opt/xiaotai-flasher/board-catalog/boards.json`，刷新页面确认新版本。前端无需重新构建。由人工维护目录时，避免运行会重新生成目录的 `catalog` 命令。

### 从 GitHub Releases 生成目录

在仓库根目录运行以下命令。生成器读取 `tangeai/xiaotai-esp32`、`tangeai/xiaotai` 和 `tangeai/xiaotai-lierda` 的 Release，生成 ESP32、BK7258、利尔达 Lite 和 Pro 共用的目录。

```bash
node scripts/generate-boards.mjs --output-dir ./releases/board-catalog
```

输出包含 `boards.json` 和 `firmware/`。将两者一起发布到同一 HTTPS 目录，再把 `boards_url` 指向生成的 `boards.json`。固件地址使用相对路径，由目录所在站点提供下载。站点与工作台不同源时，为 JSON 和固件文件配置 CORS。

默认从 GitHub 导入正式版。对于已上线的 ESP32 和 BK7258 固件，如果仓库的 `boards.json` 也把同一下载路径、同一 SHA-256 的镜像列为已发布，目录同步会保留该版本。显式加 `--include-prerelease` 可收录 ESP32、BK7258 和 Lite 的预发布版，页面标注测试版并优先推荐正式版。Pro 在线目录仅收录正式版。ESP32 的同一板型在两个仓库都有正式版时，优先推荐 `xiaotai-esp32` 的最新发布。生成器复用已校验的文件，先准备固件，再原子替换 `boards.json`。某个来源同步失败时，保留该来源上次发布的记录，已校验的其他来源可以更新，命令返回失败。GitHub API 限流时可提供 `GITHUB_TOKEN`。

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
          "bin_url": "./firmware/xiaotai-szpi-s3-v0.3.0-full-16MB.bin",
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
- `bin_url` 指向完整固件，相对地址以板卡 JSON 的位置为准。`sha256` 填实际文件的 64 位十六进制摘要。
- 使用仓库自带的同源 Nginx 路由时，固件位于 `firmware/`，文件名以字母或数字开头，允许 ASCII 字母、数字、点、下划线、加号和连字符，以 `.bin` 或 `.binpkg` 结尾。不同内容使用不同文件名。由旧版迁移时先更新 Nginx 片段并重载，确认固件可下载后再替换 `boards.json`。
- JSON 和固件跨域托管时，下载域名需允许工作台域名读取，例如 `Access-Control-Allow-Origin: https://xiaotai.chat`。

## 安装和部署

目标服务器需要 Linux、Bash、Git、Node.js（20.x 至少 20.19，或 22.12 及以上）、npm、tar、`flock` 和 Nginx。服务器需要能访问 GitHub、Release 下载地址和 npm 依赖源。以下用 `/opt/xiaotai-flasher` 作为部署目录，网址为 `https://xiaotai.chat/web-flasher/`。已登录 `root` 时可省略 `sudo`。

### 1. 安装工作台和固件目录

首次安装时，将主分支克隆到部署目录。

```bash
sudo mkdir -p /opt/xiaotai-flasher
sudo git clone --branch main \
  https://github.com/tangeai/xiaotai-flasher.git /opt/xiaotai-flasher/xiaotai-flasher
```

从特性分支迁移时，在干净的源码目录切换到主分支。已有主分支部署可直接更新。

```bash
sudo git -C /opt/xiaotai-flasher/xiaotai-flasher fetch origin
sudo git -C /opt/xiaotai-flasher/xiaotai-flasher switch main
```

安装脚本复用当前检出，构建工作台并创建 `board-catalog/firmware/`。

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

`update` 在源码目录执行 `git pull --ff-only`。遇到 Git 报告 curl 28 或 56 时，脚本分别等待 2 秒和 4 秒再试，最多拉取三次。连续失败会在构建前退出，线上继续使用当前发布。手动 `git pull` 成功只代表源码已更新。若服务器还在用旧部署脚本，拉取新源码后在仓库目录运行 `bash scripts/install.sh`，即可刷新部署脚本并执行更新。

仅固件更新时，沿用已选的目录维护方式。构建成功后 `update` 会切换前端版本。需要回滚前端时，用 `/opt/xiaotai-flasher/deploy-prod.sh status` 查看版本名，再运行 `sudo /opt/xiaotai-flasher/deploy-prod.sh rollback <版本名>`。

如果 `catalog` 下载失败，先根据日志检查该 GitHub 地址，再重跑 `catalog`。Release 附件通常会跳转到 `release-assets.githubusercontent.com`，服务器也需要能访问该域名。首次上线可以先生成正式版目录，再加 `--include-prerelease` 更新测试版。脚本会重试临时网络错误，并复用已校验的 BIN。

## 利尔达（移芯）烧录

在芯片平台选「利尔达（移芯PM HM系列）」，点「连接设备」。页面会使用已授权的唯一匹配串口，切换到下载模式并等待 QDLoader。首次使用时，按浏览器提示分别授权运行态 AT 口和下载口。已在下载模式的设备可直接授权 QDLoader。确认型号后选择固件开始烧录。

QDLoader 默认使用 `921600`。可在「高级设置」选择常用烧录波特率，或选择「自定义」并输入设备和驱动支持的速率。AgentBoot 协议以 100 为单位记录速率，自定义值须是 100 到 3276700 之间的 100 的整数倍。下一次连接时使用新速率，运行态 AT 口使用 `115200`。连接长时间无响应时，可以取消，恢复默认速率后再连接。

使用「小钛固件」时，按板型选择已发布的版本。使用「本地 BINPKG」时，直接选择固件包。连接设备后，工作台依据底包指纹和应用布局识别板型，再按该板型校验固件包。校验通过后才能烧录。擦除前再次核对当前设备的完整底包和应用布局。

- `lierda-ec718pm-lite` 是 NT26F6D0 Lite 语音版，使用 F6D_D。写前备份 4 MiB 内部 Flash，写入后回读校验。
- `lierda-ec718pm-pro` 是 NT26F6D0 Pro 语音版，使用 F6D_D。目录接受包含外置 Flash 资源的完整五镜像包。此板型的网页烧录仍在适配。
- `lierda-ec718hm-pro` 是 NT26F9D0 Pro 视频通话版。网页自动识别设备和固件包的 F9D_D 1.7.0 或 1.7.1 布局。布局一致时只更新 APP。两个已识别布局之间切换时，确认框会列出擦除范围，点击「清除数据并重装」会重新写入底包和 APP，清空应用文件系统，保留并校验出厂数据与校准区。两种方式都在写入前保存 8 MiB 内部 Flash 备份。

### 更新利尔达在线版本

在固件仓库创建 `vX.Y.Z` Release。同一 Release 中每款开发板可独立编号，上传一个 `v<该板产品版本>-<板型标识>.binpkg`。网页按附件名显示该板版本。整批再上传一份 `SHA256SUMS.txt`，按 `sha256sum` 格式列出各附件的 SHA-256 和完整文件名。可以只发布其中一块板。例如 `v1.0.0-lierda-ec718pm-lite.binpkg` 只会出现在 PM Lite 的版本列表里。[小钛利尔达 Releases](https://github.com/tangeai/xiaotai-lierda/releases)

旧标签 `lite-vX.Y.Z` 仍对应 PM Lite，`pro-vX.Y.Z` 仍对应 HM Pro。网页按所选版本和板型显示标准包名，鼠标悬停可查看原始附件名。

网页发布沿用 `sudo /opt/xiaotai-flasher/deploy-prod.sh update`。仓库内的 `public/lierda/agentboot-ec718pm-usb.bin` 随网页发布。发布脚本会在生成归档前校验产物中的 USB AgentBoot 大小和 SHA-256。站点的固件目录使用仓库 Nginx 配置提供 `.bin` 和 `.binpkg`。[利尔达官方工具说明](https://opendocs.lierda.com/docs/CAT.1_Doc_Protal/en/general/command_devlop.html)

任一平台发布新固件时，沿用工作台原有的统一目录同步命令。

```bash
sudo /opt/xiaotai-flasher/deploy-prod.sh catalog
```

工作台从 `boards-source.json` 指向的同一份 `boards.json` 读取各平台版本，并为每款开发板推荐最新正式版。利尔达固件还会校验模组、底包及应用分区。在线目录不可用时，可选择本地固件。

旧部署若有 `catalog-lite` 定时任务，它仍只刷新旧版 Lite 目录。统一的 `catalog` 任务生效后即可移除旧任务。

可通过 `/web-flasher/?board=<板型标识>` 直达对应型号。原有 `?board=lierda-lite` 和 `?board=lierda-pro` 链接分别打开 PM Lite 和 HM Pro。网页烧录使用厂商的 50,032 字节 USB AgentBoot，SHA-256 为 `045bd0c74a030143230f07484e4711600005b992e3b0776be042e42d141a38e5`。

## 本地开发

```bash
npm ci
npm run dev      # http://localhost:5173/
```

执行 `npm run build` 生成 `dist/`，再用 `npm run preview` 检查构建结果。
执行 `npm test` 可验证固件目录、镜像校验、ESP32 Flash 参数，以及 BK7258 的模拟串口流程。
