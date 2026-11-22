# 小钛在线烧录工作台

工作台使用 React + Vite。桌面 Chrome 或 Edge 通过 Web Serial 连接设备。ESP32 完整 BIN 默认从 `0x0` 写入，校验通过后可以进入串口日志，再重新配网和绑定。串口日志也可以单独连接。

## 开发与发布

- `npm ci` 安装依赖。
- `npm run dev` 启动本地开发页，默认访问 `http://localhost:5173/`。
- `npm run build` 生成 `dist/`。
- `npm run preview` 预览构建结果。

官网可将 `dist/` 挂载到 `/web-flasher/`，并将 `/web-flasher` 跳转到带尾部斜杠的路径，保留查询参数。发布使用 HTTPS。

### 发布脚本

在装有 Bash、Node.js、npm 和 tar 的机器上，执行以下命令生成静态发布包：

```bash
./scripts/release.sh --boards-url https://firmware.example.com/xiaotai/boards.json
```

脚本默认安装锁定的依赖并构建，将 `.tar.gz` 写入 `releases/`。可用 `--output-dir` 指定输出目录。省略 `--boards-url` 时，使用仓库里的 `public/boards-source.json`。命令行指定的链接只写入发布包。已安装依赖时可传 `--skip-install`。

在静态站点所在机器上，可以生成发布包并切换部署目录：

```bash
./scripts/release.sh \
  --boards-url https://firmware.example.com/xiaotai/boards.json \
  --deploy-dir /var/www/xiaotai/web-flasher
```

将网站的 `/web-flasher/` 指向该部署路径。首次发布时使用尚未占用的路径，脚本会建立指向版本目录的符号链接，后续发布原子切换该链接。已有独立静态发布流程的站点，可把压缩包解压到该流程使用的目录。

## 配置板卡目录链接

在 [`public/boards-source.json`](public/boards-source.json) 填写板卡 JSON 的直链。Vite 会原样复制到 `dist/boards-source.json`。已发布的静态站点可替换这个配置文件来切换链接，无需重新构建 JavaScript。

```json
{
  "boards_url": "https://firmware.example.com/xiaotai/boards.json"
}
```

`boards_url` 也可填站内或相对路径。默认读取随项目提供的空目录 `./firmware-catalog.json`，此时可使用本地 BIN。

### 板卡目录格式

以下内容是格式示例。发布前用实际版本、BIN 链接和 SHA‑256 替换示例值。

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

- `slug` 是唯一的板卡标识。用 `/web-flasher?board=lckfb-esp32s3` 预选该板。
- `status` 支持 `draft`、`published`、`offline`。`published` 版本会显示在工作台。每块板最多有一个推荐版本。
- `bin_url` 指向完整 BIN。相对地址以板卡 JSON 的位置为准。写入地址固定为 `0x0`。
- `sha256` 用实际 BIN 的 64 位十六进制摘要。网页下载后会校验。
- 外部 JSON 和 BIN 服务需要允许浏览器从工作台域名跨域读取。例如，服务端可针对官网设置 `Access-Control-Allow-Origin: https://xiaotai.chat`。
