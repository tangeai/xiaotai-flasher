# 小钛在线烧录工作台

工作台使用 React + Vite。桌面 Chrome 或 Edge 通过 Web Serial 连接设备。ESP32 完整 BIN 默认从 `0x0` 写入，校验通过后可以进入串口日志，再重新配网和绑定。串口日志也可以单独连接。

## 开发与发布

- `npm ci` 安装依赖。
- `npm run dev` 启动本地开发页，默认访问 `http://localhost:5173/`。
- `npm run build` 生成 `dist/`。
- `npm run preview` 预览构建结果。

官网可将 `dist/` 挂载到 `/web-flasher/`，并将 `/web-flasher` 跳转到带尾部斜杠的路径，保留查询参数。发布使用 HTTPS。

### 首次安装

准备 Bash、Git、Node.js、npm、tar 和 flock。在目标服务器上运行：

```bash
curl -fsSLo /tmp/xiaotai-flasher-install.sh \
  https://raw.githubusercontent.com/tangeai/xiaotai-flasher/main/scripts/install.sh
bash -n /tmp/xiaotai-flasher-install.sh
sudo env BOARDS_URL=https://firmware.example.com/xiaotai/boards.json \
  bash /tmp/xiaotai-flasher-install.sh
```

安装器默认将 `main` 克隆到 `/opt/xiaotai-flasher/xiaotai-flasher`，首次发布到 `/opt/xiaotai-flasher/www/web-flasher`。可通过 `DEPLOY_ROOT`、`REPO_URL` 和 `REPO_BRANCH` 覆盖目录、源仓库和初始分支。Node.js 和 npm 需要在实际执行安装的用户环境中可用。

将 [Nginx 路由示例](deploy/nginx/xiaotai-flasher.conf) 加入现有 HTTPS 站点的 `server` 块。自定义安装目录时同步修改 `alias`。配置检查通过后重新加载 Nginx。

### 更新与回滚

```bash
sudo /opt/xiaotai-flasher/deploy-prod.sh update
/opt/xiaotai-flasher/deploy-prod.sh status
sudo /opt/xiaotai-flasher/deploy-prod.sh rollback xiaotai-flasher-20261122T043106Z-Qw5qba
```

`update` 快进拉取安装时选定的分支，构建成功后原子切换静态目录。相同提交和板卡目录配置会跳过重建。需要重建时用 `sudo env FORCE_UPDATE=1 /opt/xiaotai-flasher/deploy-prod.sh update`。回滚命令中的版本名用 `status` 列出的实际名称替换。

服务器上的 `/opt/xiaotai-flasher/boards-source.json` 由首次安装写入。更新代码时保留该文件。更换板卡目录链接后再次运行 `update`。

### 单独打包

```bash
./scripts/release.sh --boards-url https://firmware.example.com/xiaotai/boards.json
```

脚本将静态压缩包写入 `releases/`，可用 `--output-dir` 指定输出目录。省略 `--boards-url` 使用源码中的 `public/boards-source.json`。有可用依赖时可传 `--skip-install`。在当前服务器手动发布可传 `--deploy-dir`，首次选择空闲路径，后续原子切换发布链接。

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
