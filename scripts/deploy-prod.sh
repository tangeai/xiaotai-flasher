#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'HELP'
用法: deploy-prod.sh <命令>

  update        快进拉取、构建并发布
  catalog       从 GitHub Releases 同步 ESP32、BK7258 和利尔达 Lite、Pro，可加 --include-prerelease
  status        查看当前发布、源码提交、板卡目录和可用版本
  rollback 版本  切换到 status 列出的指定版本
  help          显示此帮助

环境变量：
  DEPLOY_ROOT   部署根目录，默认使用安装目录或 /opt/xiaotai-flasher
  FORCE_UPDATE  设为 1 可在同一提交和配置下重新构建
HELP
}

fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }
log() { printf '[INFO] %s\n' "$*"; }

command="${1:-help}"
case "$command" in
  help|-h|--help) usage; exit ;;
  update|status|catalog-lite) [[ $# -eq 1 ]] || fail "$command 不接受位置参数。" ;;
  catalog) [[ $# -eq 1 || ( $# -eq 2 && "$2" = --include-prerelease ) ]] || fail 'catalog 仅接受 --include-prerelease。' ;;
  rollback) [[ $# -eq 2 ]] || fail '请指定 status 显示的版本目录名。' ;;
  *) usage >&2; exit 2 ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
default_root=/opt/xiaotai-flasher
if [[ -d "$script_dir/xiaotai-flasher/.git" ]]; then default_root="$script_dir"; fi
root="${DEPLOY_ROOT:-$default_root}"
[[ "$root" = /* && -d "$root" ]] || fail 'DEPLOY_ROOT 必须是已安装的绝对路径。'
root="$(cd -- "$root" && pwd -P)"
[[ "$root" != / ]] || fail 'DEPLOY_ROOT 不能是文件系统根目录。'
repo="$root/xiaotai-flasher"
site="$root/www/web-flasher"
config="$root/boards-source.json"
publisher="$repo/scripts/site-release.mjs"
[[ -d "$repo/.git" && -f "$publisher" ]] || fail '部署目录尚未初始化，请先运行 install.sh。'

if [[ "$command" == status ]]; then
  node "$publisher" status "$site"
  exit
fi

exec 9>"$root/deploy.lock"
flock -n 9 || fail '另一个安装或发布任务正在运行。'

if [[ "$command" == rollback ]]; then
  node "$publisher" rollback "$site" "$2"
  exit
fi

if [[ "$command" == catalog ]]; then
  shift
  umask 022
  exec node "$repo/scripts/generate-boards.mjs" --output-dir "$root/board-catalog" "$@"
fi

# Older schedules may still refresh the legacy Lite directory.
if [[ "$command" == catalog-lite ]]; then
  umask 022
  exec node "$repo/scripts/import-lierda-lite.mjs" --output-dir "$root/lierda-lite-firmware"
fi

[[ -z "$(git -C "$repo" status --porcelain)" ]] || fail '生产源码目录有未提交修改，请先处理。'
pull_update() {
  local attempt output status
  for attempt in 1 2 3; do
    if output="$(git -C "$repo" pull --ff-only 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi
    printf '%s\n' "$output" >&2
    if [[ $attempt == 3 || ! "$output" =~ curl[[:space:]]+(28|56)([^0-9]|$) ]]; then
      return "$status"
    fi
    log "GitHub 连接中断，即将重试（$((attempt + 1))/3）。"
    sleep "$((attempt * 2))"
  done
}
pull_update
commit="$(git -C "$repo" rev-parse HEAD)"
[[ "$commit" == "$(git -C "$repo" rev-parse '@{upstream}')" ]] || fail '生产源码提交与上游不一致。'
boards_url="$(node --input-type=module - "$config" <<'NODE'
import { readFileSync } from 'node:fs';

const { boards_url } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (typeof boards_url !== 'string' || !boards_url.trim()) throw new Error('请在部署目录的 boards-source.json 中配置 boards_url。');
process.stdout.write(boards_url);
NODE
)"

if [[ "${FORCE_UPDATE:-0}" != 1 ]]; then
  if node "$publisher" matches "$site" "$commit" "$boards_url"; then
    log '当前发布的源码与板卡目录配置一致。'
    exit
  else
    result=$?
    [[ "$result" == 1 ]] || exit "$result"
  fi
fi

"$repo/scripts/release.sh" --boards-url "$boards_url" --output-dir "$root/releases" --deploy-dir "$site"
replacement="$(mktemp "$root/.deploy-prod.XXXXXX")"
trap 'rm -f -- "$replacement"' EXIT
install -m 0755 -- "$repo/scripts/deploy-prod.sh" "$replacement"
mv -- "$replacement" "$root/deploy-prod.sh"
log "发布源码 $commit"
