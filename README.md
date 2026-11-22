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

默认目录为空，可直接导入本地 BIN。通过生产安装脚本部署后，以部署根目录下的 `boards-source.json` 为准，换链接后执行 `update`。独立静态站点也可以直接替换部署目录里的 `boards-source.json`。

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
- JSON 和 BIN 跨域托管时，下载域名需允许工作台域名读取。例如 `Access-Control-Allow-Origin: https://xiaotai.chat`。
- 在同一个目录链接下发新版固件时，上传新 BIN 并更新板卡 JSON 即可。

## 部署到官网

生产部署需要 Linux、Bash、Git、Node.js（20.x 至少 20.19，或 22.12 及以上）、npm、tar 和 flock。以下以官网现有 HTTPS Nginx 提供 `https://xiaotai.chat/web-flasher/` 为例。工作台和固件同源部署，后台可直接链接到该页面。

| 脚本 | 用途 |
| --- | --- |
| [`scripts/install.sh`](scripts/install.sh) | 首次克隆、保存板卡目录配置、构建并发布 |
| [`scripts/deploy-prod.sh`](scripts/deploy-prod.sh) | 更新网站、生成板卡目录、查看状态或回滚网站 |
| [`scripts/release.sh`](scripts/release.sh) | 生成静态发布包，也可部署到指定目录 |

### 首次安装

在目标服务器执行以下命令。`sudo` 环境需能找到 Node.js 和 npm。使用自有固件下载站点时，将 `BOARDS_URL` 换成其实际 HTTPS 链接，并在下载端为 JSON 和 BIN 配置 CORS。

```bash
installer=$(mktemp /tmp/xiaotai-flasher-install.XXXXXX)
curl -fsSLo "$installer" \
  https://raw.githubusercontent.com/tangeai/xiaotai-flasher/main/scripts/install.sh &&
bash -n "$installer" &&
sudo env BOARDS_URL=/web-flasher/board-catalog/boards.json bash "$installer" &&
sudo /opt/xiaotai-flasher/deploy-prod.sh catalog
```

如果服务器访问 `raw.githubusercontent.com` 时 TLS 连接被重置，可改从 `github.com` 克隆后执行安装脚本。

```bash
bootstrap=$(mktemp -d /tmp/xiaotai-flasher-bootstrap.XXXXXX)
git clone --depth=1 https://github.com/tangeai/xiaotai-flasher.git "$bootstrap" &&
sudo env BOARDS_URL=/web-flasher/board-catalog/boards.json \
  bash "$bootstrap/scripts/install.sh" &&
sudo /opt/xiaotai-flasher/deploy-prod.sh catalog
```

如果目标服务器也无法下载 GitHub 仓库或固件附件，在可联网的机器生成静态包和固件目录，再传到目标服务器。静态包内容放入 `/opt/xiaotai-flasher/www/web-flasher/`，固件目录内容放入 `/opt/xiaotai-flasher/board-catalog/`。已有脚本管理的版本时，用发布脚本切换版本。

```bash
./scripts/release.sh --boards-url /web-flasher/board-catalog/boards.json
node scripts/generate-boards.mjs --output-dir ./releases/board-catalog
```

默认部署根目录是 `/opt/xiaotai-flasher`。可用 `DEPLOY_ROOT`、`REPO_URL`、`REPO_BRANCH` 指定其他安装目录、仓库或分支。默认从 `main` 安装，后续更新跟随安装时选择的分支。

已有安装要切换到同源目录时，用 `sudoedit /opt/xiaotai-flasher/boards-source.json` 将 `boards_url` 改为 `/web-flasher/board-catalog/boards.json`，再执行 `update` 和 `catalog`，最后更新 Nginx 路由。

| 路径 | 内容 |
| --- | --- |
| `/opt/xiaotai-flasher/xiaotai-flasher/` | 服务器上的源码检出 |
| `/opt/xiaotai-flasher/boards-source.json` | 独立板卡目录配置 |
| `/opt/xiaotai-flasher/www/web-flasher` | 指向当前静态版本的发布链接 |
| `/opt/xiaotai-flasher/board-catalog/` | 板卡目录和经过校验的 BIN |
| `/opt/xiaotai-flasher/releases/` | 构建生成的静态压缩包 |

### 配置 Nginx 和验收

将路由片段复制到 `/etc/nginx/snippets/`，再在处理 `xiaotai.chat` 的现有 HTTPS `server` 块内加入 `include`。如果这个 `server` 已定义 `/web-flasher` 路由，先用此片段替换旧定义。自定义安装目录时，修改片段中各处 `/opt/xiaotai-flasher/`。确认 Nginx 的 `http` 块加载 `mime.types`，工作进程能读取发布文件和进入其上层目录。 [Nginx 路由片段](deploy/nginx/xiaotai-flasher.conf)

```bash
sudo install -D -m 0644 \
  /opt/xiaotai-flasher/xiaotai-flasher/deploy/nginx/xiaotai-flasher.conf \
  /etc/nginx/snippets/xiaotai-flasher.conf
```

```nginx
include /etc/nginx/snippets/xiaotai-flasher.conf;
```

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsSI 'https://xiaotai.chat/web-flasher?board=lckfb-esp32s3'
curl -fsSI https://xiaotai.chat/web-flasher/
curl -fsS https://xiaotai.chat/web-flasher/boards-source.json
curl -fsS https://xiaotai.chat/web-flasher/board-catalog/boards.json
```

首个请求应返回 `308`，跳转地址保留 `?board=...`。页面、配置及板卡 JSON 应返回 `200`，页面与 JSON 每次使用前重新验证缓存。带内容哈希的前端资源和 BIN 可以长期缓存。目录中的 BIN 应返回 `200` 和 `application/octet-stream`，不存在的文件应返回 `404`。HTTPS 站点如设有 CSP 或 `Permissions-Policy`，需允许本站脚本、目录下载和同源 Web Serial。官网后台使用普通链接打开工作台。 [Nginx 缓存说明](https://nginx.org/en/docs/http/ngx_http_headers_module.html#expires) · [Web Serial 说明](https://developer.chrome.com/docs/capabilities/serial)

用桌面 Chrome 或 Edge 打开带 `board` 参数的链接，确认板卡和推荐版本预选。接一块实际设备完成连接、烧录、写入校验和复位，验证自动日志及手动连接日志。若板卡有独立的烧录和日志接口，分别选择对应串口。

### 更新与回滚

```bash
sudo /opt/xiaotai-flasher/deploy-prod.sh update
sudo /opt/xiaotai-flasher/deploy-prod.sh catalog
/opt/xiaotai-flasher/deploy-prod.sh status
sudo /opt/xiaotai-flasher/deploy-prod.sh rollback xiaotai-flasher-20261122T043106Z-Qw5qba
```

- `update` 快进拉取并在构建成功后原子切换发布链接。源码提交和板卡目录链接都一致时跳过重建。用 `sudo env FORCE_UPDATE=1 /opt/xiaotai-flasher/deploy-prod.sh update` 可强制重建。
- `catalog` 单独更新固件目录。已有内容相同的 BIN 会复用，目录更新失败时仍可读取上一次的 `boards.json`。仅固件发版时执行这个命令即可，无需构建网站或重载 Nginx。
- 更换板卡目录链接时，修改部署根目录下的 `boards-source.json` 后执行 `update`。代码更新会保留这个文件。
- `rollback` 的参数换成 `status` 列出的实际版本名。它切换前端版本。若也需要回滚固件目录，用事先备份的 `boards.json` 原子替换当前目录文件，并保留该版本引用的 BIN。回滚后，下一次 `update` 会按当前源码和服务器配置重新发布。

## 本地开发和单独打包

```bash
npm ci
npm run dev      # http://localhost:5173/
```

执行 `npm run build` 生成 `dist/`，再用 `npm run preview` 检查构建结果。
执行 `npm test` 可验证启动镜像校验与 Flash 参数修改。

已有静态站点发布流程时，可用以下命令生成压缩包，并将包内文件部署到 `/web-flasher/`：

```bash
./scripts/release.sh --boards-url https://firmware.example.com/xiaotai/boards.json
```

压缩包默认写入 `releases/`，可用 `--output-dir` 覆盖。已安装依赖可传 `--skip-install`。也可以加 `--deploy-dir /var/www/xiaotai/web-flasher` 在当前服务器直接切换静态发布链接，首次使用未占用的路径。
