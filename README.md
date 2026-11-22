# 小钛在线烧录工作台

用浏览器通过 USB 串口烧录小钛或本地 ESP32 固件，并在同一页面查看设备串口日志。前端使用 React + Vite，烧录使用乐鑫 `esptool-js`。工作台按静态站点部署，板卡目录通过独立 JSON 链接维护。

## 功能

| 功能 | 说明 |
| --- | --- |
| ESP32 在线烧录 | 适用 ESP32、ESP32-S2、ESP32-S3、ESP32-C2、ESP32-C3、ESP32-C5、ESP32-C6、ESP32-H2、ESP32-P4 |
| 固件选择 | 选择已发布的小钛固件，或导入本地完整 `.bin`。完整镜像固定从 `0x0` 写入 |
| 写入校验 | 连接后识别芯片和 Flash 容量。下载小钛固件时校验 SHA‑256，写入后校验设备上的内容 |
| 串口日志 | 独立连接运行中的设备，或在烧录结束后自动打开。可选波特率、暂停滚动、清空、复制和下载 |
| 高级设置 | 支持多 BIN 分段地址、烧录波特率、Flash 模式、频率、容量及复位方式。全片擦除默认关闭 |
| 工作台布局 | 固件和进度与日志并排显示，支持全屏，右上角可打开连接与排查 |

## 使用工作台

使用桌面版 Chrome 或 Edge 打开 HTTPS 页面。本机开发可使用 `localhost`。用可传数据的 USB 线连接开发板，关闭占用串口的工具。

1. 在「小钛固件」选择完整板卡型号和版本，或在「本地 BIN」选择适配该板卡的完整镜像。应用分区 BIN 请在「分段烧录」中按固件说明填写地址。
2. 点击「连接设备」，在浏览器弹窗选择开发板串口。核对页面检测到的芯片和 Flash 容量。
3. 点击「开始烧录」并确认固件。等进度显示「烧录完成，校验通过」。完整镜像烧录后请重新配网和绑定设备。
4. 在右侧「串口日志」查看设备启动输出。也可直接点「连接日志串口」，默认波特率为 `115200`，UART 速率需与固件设置一致。设备重启后串口变化时，重新选择日志串口。

连接失败时，打开右上角「连接与排查」，按板卡说明进入下载模式。写入不稳定时，可在高级设置中降低烧录波特率。

## 配置小钛固件目录

### 设置目录链接

在源码 [`public/boards-source.json`](public/boards-source.json) 填写板卡 JSON 的 HTTPS 直链或站内路径。首次用安装脚本部署时，也可以通过 `BOARDS_URL` 填写：

```json
{
  "boards_url": "https://firmware.example.com/xiaotai/boards.json"
}
```

默认目录为空，可直接导入本地 BIN。通过生产安装脚本部署后，以部署根目录下的 `boards-source.json` 为准，换链接后执行 `update`。独立静态站点也可以直接替换部署目录里的 `boards-source.json`。

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

生产部署需要 Linux、Bash、Git、Node.js（20.x 至少 20.19，或 22.12 及以上）、npm、tar 和 flock。站点由现有 HTTPS 网关提供访问。

| 脚本 | 用途 |
| --- | --- |
| [`scripts/install.sh`](scripts/install.sh) | 首次克隆、保存板卡目录配置、构建并发布 |
| [`scripts/deploy-prod.sh`](scripts/deploy-prod.sh) | 快进更新、查看发布状态、回滚 |
| [`scripts/release.sh`](scripts/release.sh) | 生成静态发布包，也可部署到指定目录 |

### 首次安装

在目标服务器执行，将示例 `BOARDS_URL` 换成实际链接。执行安装的用户需要能运行 Node.js 和 npm。

```bash
curl -fsSLo /tmp/xiaotai-flasher-install.sh \
  https://raw.githubusercontent.com/tangeai/xiaotai-flasher/main/scripts/install.sh
bash -n /tmp/xiaotai-flasher-install.sh
sudo env BOARDS_URL=https://firmware.example.com/xiaotai/boards.json \
  bash /tmp/xiaotai-flasher-install.sh
```

默认部署根目录是 `/opt/xiaotai-flasher`。可用 `DEPLOY_ROOT`、`REPO_URL`、`REPO_BRANCH` 指定其他安装目录、仓库或分支。默认从 `main` 安装，后续更新跟随安装时选择的分支。

| 路径 | 内容 |
| --- | --- |
| `/opt/xiaotai-flasher/xiaotai-flasher/` | 服务器上的源码检出 |
| `/opt/xiaotai-flasher/boards-source.json` | 独立板卡目录配置 |
| `/opt/xiaotai-flasher/www/web-flasher` | 指向当前静态版本的发布链接 |
| `/opt/xiaotai-flasher/releases/` | 构建生成的静态压缩包 |

### 配置 Nginx 和验收

将 [Nginx 路由示例](deploy/nginx/xiaotai-flasher.conf) 加到官网现有 HTTPS `server` 块。自定义安装目录时，同步修改 `alias`。该路由将 `/web-flasher` 重定向到带末尾斜杠的 `/web-flasher/`，并保留 `?board=...`。以下重载命令适用于由 systemd 管理的 Nginx。

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsSL -o /dev/null 'https://xiaotai.chat/web-flasher?board=lckfb-esp32s3'
```

用浏览器打开链接，确认板卡预选和 BIN 下载正常。用实际设备验证连接、写入校验、重启和串口日志，再启用后台入口。

### 更新与回滚

```bash
sudo /opt/xiaotai-flasher/deploy-prod.sh update
/opt/xiaotai-flasher/deploy-prod.sh status
sudo /opt/xiaotai-flasher/deploy-prod.sh rollback xiaotai-flasher-20261122T043106Z-Qw5qba
```

- `update` 快进拉取并在构建成功后原子切换发布链接。源码提交和板卡目录链接都一致时跳过重建。用 `sudo env FORCE_UPDATE=1 /opt/xiaotai-flasher/deploy-prod.sh update` 可强制重建。
- 更换板卡目录链接时，修改部署根目录下的 `boards-source.json` 后执行 `update`。代码更新会保留这个文件。
- `rollback` 的参数换成 `status` 列出的实际版本名。回滚后，下一次 `update` 会按当前源码和服务器配置重新发布。

## 本地开发和单独打包

```bash
npm ci
npm run dev      # http://localhost:5173/
```

执行 `npm run build` 生成 `dist/`，再用 `npm run preview` 检查构建结果。

已有静态站点发布流程时，可用以下命令生成压缩包，并将包内文件部署到 `/web-flasher/`：

```bash
./scripts/release.sh --boards-url https://firmware.example.com/xiaotai/boards.json
```

压缩包默认写入 `releases/`，可用 `--output-dir` 覆盖。已安装依赖可传 `--skip-install`。也可以加 `--deploy-dir /var/www/xiaotai/web-flasher` 在当前服务器直接切换静态发布链接，首次使用未占用的路径。
