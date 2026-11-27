# 本地固件目录同步规则

需要 Python 3.8 或更新版本，仅使用标准库。在仓库根目录运行以下命令。

```bash
python3 scripts/sync_firmware.py
```

Windows 可用 `py -3 scripts/sync_firmware.py`。指定其他已有目录时，使用 `--catalog-dir /path/to/board-catalog`。项目内也可运行 `npm run sync:firmware`。如果 GitHub API 达到匿名访问限额，可通过环境变量 `GITHUB_TOKEN` 提供令牌。

**换机器或清理目录前，请保留以下文件。**

- `board-catalog/boards.json` 是同步输入，包含平台、板型和已有版本记录。该目录由 Git 忽略，新检出项目时需要从已有目录复制这份文件。
- Xmini 和四博的旧 Release 已下线。每款板至少保留一份完整 BIN，可以是 `board-catalog/firmware/` 中的现用文件，也可以是项目 `releases/**/firmware/` 中的原始归档。脚本会按目录记录的 SHA-256 核对后恢复。

首次运行或目录内容有变化时，输出一个 UTC 时间命名的快照，例如 `board-catalog/boards-2026-11-27T07-30-45.123456Z.json`。原始 `boards.json` 保留供下次读取。发布时可以先核对快照，再将它与所引用的 `firmware/` 文件一起部署。旧快照和旧固件会保留在磁盘上。

下次运行仍会检查三个仓库的 Release。已通过大小和 SHA-256 校验的文件直接复用。每次只补齐各仓库最新正式 Release 中缺失的匹配固件。若仅删了该 Release 的 JSON 条目，脚本会校验并复用已有文件，在新快照中恢复条目。生成内容与最近一次快照一致时，命令显示“固件和目录已是最新”并返回已有快照路径。已有同名文件的摘要有冲突时，脚本报出具体路径并停止，以保护旧快照引用的内容。

每条固件记录用 `source_url` 保存重命名前的附件地址，供核对来源。工作台仍通过 `bin_url` 下载已校验的本地文件。Xmini 和四博的旧 Release 已下线，其历史附件地址按旧目录中的仓库、标签和原文件名还原；若归档缺少仓库或标签，则保留旧目录的来源路径。

## 验证记录

2026-11-27 使用 Python 3.10.12 在临时目录实测。保留现用 `boards.json` 和两份 C3 原始归档，从空的 `firmware/` 开始运行。

| 场景 | 实测结果 |
| --- | --- |
| 首次同步 | 从三个仓库下载 13 个固件，从归档恢复 Xmini 和四博各 1 个。生成的快照包含 13 款板、15 个文件，逐项 SHA-256 均匹配。 |
| 再运行一次 | 复用同一份日期快照，固件下载数为 0。 |
| 用新快照作输入，再删除 C3 的本地 BIN | 按 `source_url` 中的原文件名找到备份，校验后恢复到 `bin_url` 指定的位置。 |
| 模拟下载截断或摘要错误 | 保留上一份快照，未完成的文件不会出现在 `firmware/`。修复下载源后，重跑同一命令即可。 |

在仓库根目录可运行离线回归测试，覆盖版本筛选、旧名映射、缓存复用、归档恢复和下载失败重试。本次 8 项测试全部通过。

```bash
python3 -B test/test_sync_firmware.py
```

## 选择 Release 和附件

1. 依次读取 [xiaotai-esp32](https://github.com/tangeai/xiaotai-esp32/releases)、[xiaotai](https://github.com/tangeai/xiaotai/releases)、[xiaotai-lierda](https://github.com/tangeai/xiaotai-lierda/releases)。每个仓库按发布时间只取最新的一个正式 Release，跳过草稿和预发布。一次 Release 可以包含多块板。
2. ESP32 只收完整的 merged 或旧版 full 镜像，BK7258 收 all-app，利尔达收 BINPKG。在选中的 Release 内，同板型、同固件版本有多个 IDF 构建时，按数字版本选最高的一份，例如 6.10 高于 6.9。部分旧包的默认构建省略 IDF 后缀，脚本从发布说明中该附件对应的表格行读取版本。
3. 每块板的 ESP32 专仓固件排在通用仓库之前。两个来源产生同一目标文件名时，优先保留先处理的来源，并记录跳过的附件。每块板的第一个已发布条目标为推荐。
4. 固件文件名使用附件自身版本。例如利尔达同一个 Release 中的 Lite 和 Pro 可以有不同版本。旧版时间戳 BINPKG 从可识别的标签取版本。文件大小和 SHA-256 均须与 GitHub 附件一致，校验通过才写入快照。相同内容可从本地复用。
5. 原样沿用本地的平台定义和已有板型的 `platform`、`platform_name`。已有板型即使本轮没有匹配的附件也保留。Xmini 和四博的旧标签已无法通过 Release API 获取；这两块板缺少线上版本时，脚本按原始目录记录检查本地 `firmware/` 和同项目 `releases/**/firmware/`。若输入的 `boards.json` 已采用新文件名，脚本也会从 `source_url` 识别对应的原始附件名。摘要一致才按正式名称恢复，并保留原发布标签和测试版标记。其余没有匹配附件的板型保留空版本列表。无法匹配的固件或本地板型在终端列出，下载或校验失败时不发布快照。

## 板型、旧名称与存储名

表中的 `vX.Y.Z` 表示实际固件版本。所有文件都在快照的同级 `firmware/` 下，JSON 使用相对路径 `./firmware/<存储名>`。

| 正式 slug | 型号 | 存储名 | 兼容的其他标识 |
| --- | --- | --- | --- |
| lckfb-esp32s3 | 立创实战派开发板 · ESP32-S3 | `vX.Y.Z_lckfb-esp32s3_merged.bin` | szpi-s3 |
| m5stack-esp32s3-cores3-lite | M5Stack开发板 · ESP32-S3(CoreS3-Lite) | `vX.Y.Z_m5stack-esp32s3-cores3-lite_merged.bin` | m5stack-cores3-lite、cores3-lite、m5stack-cores3-lite_ili9342c |
| waveshare-p4-3.5 | 微雪开发板 · ESP32-P4(3.5寸屏) | `vX.Y.Z_waveshare-esp32p4-3.5_merged.bin` | waveshare-esp32p4-3.5、waveshare-p4-rev3 |
| waveshare-p4-4.3 | 微雪开发板 · ESP32-P4(4.3寸屏) | `vX.Y.Z_waveshare-esp32p4-4.3_merged.bin` | waveshare-esp32p4-4.3、waveshare-esp32p4-touch-lcd-43c-v10 |
| qiming-esp32p4 | 启明开发板 · ESP32-P4 | `vX.Y.Z_qiming-esp32p4_merged.bin` | wt99p461-s1-1v1 |
| xmini-esp32c3 | Xmini-esp32c3 · ESP32-C3 | `vX.Y.Z_xmini-esp32c3_merged.bin` | xmini-c3-v3 |
| sibo-esp32c3 | 四博-ESP32-C3 | `vX.Y.Z_sibo-esp32c3_merged.bin` | mz28-ai-ppd-v12、mz28 |
| esp32s31 | ESP32S31 | `vX.Y.Z_eps32s31_merged.bin` | jc1060f570c（GUITION-JC1060F570C-V1.0），存储名沿用 eps32s31 |
| lckfb-bk7258 | 立创实战派开发板 · BK7258 | `vX.Y.Z_lckfb-bk7258_all-app.bin` | — |
| mgkfb-bk7258 | 觅感 AI 玩具开发板 · BK7258（双屏眼睛） | `vX.Y.Z_mgkfb-bk7258_all-app.bin` | — |
| lierda-ec718pm-lite | EC718PM-Lite语音板 | `vX.Y.Z_lierda-ec718pm-lite.binpkg` | 旧时间戳附件的 lite 后缀 |
| lierda-ec718pm-pro | EC718PM-Pro语音板 | `vX.Y.Z_lierda-ec718pm-pro.binpkg` | 0.2.0 标签的时间戳 pro 附件 |
| lierda-ec718hm-pro | EC718HM-Pro视频板 | `vX.Y.Z_lierda-ec718hm-pro.binpkg` | — |

旧式 ESP32 镜像可用 `xiaotai-<标识>-vX.Y.Z-full-16MB.bin` 等名称发布；旧式利尔达附件可用 `vX.Y.Z-<slug>.binpkg`。同步后均使用表中的存储名。利尔达条目的 `source_filename` 仍记录实际发布附件名。

例如 `v0.4.0_cores3-lite_idf6.0_merged.bin` 对应的正式 slug 为 `m5stack-esp32s3-cores3-lite`，在目录中保存为 `./firmware/v0.4.0_m5stack-esp32s3-cores3-lite_merged.bin`。

同一 Release 中，`v0.4.0_szpi-s3_idf6.0_merged.bin` 对应的正式 slug 为 `lckfb-esp32s3`，保存为 `./firmware/v0.4.0_lckfb-esp32s3_merged.bin`。

`v0.4.0_wt99p461-s1-1v1_idf5.5_merged.bin` 和对应的 IDF 6.0 构建都归入 `qiming-esp32p4`。两者同时发布时，选用 IDF 6.0，保存为 `./firmware/v0.4.0_qiming-esp32p4_merged.bin`。
