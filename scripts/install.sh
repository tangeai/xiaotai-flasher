#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

usage() {
  cat <<'HELP'
用法: install.sh [install]

从 Git 仓库首次安装并发布小钛烧录工作台。

环境变量：
  DEPLOY_ROOT  部署根目录，默认 /opt/xiaotai-flasher
  REPO_URL     源码仓库，默认 https://github.com/tangeai/xiaotai-flasher.git
  REPO_BRANCH  首次安装时克隆的分支，默认 main
  BOARDS_URL   首次安装时写入 boards-source.json 的板卡目录地址
HELP
}

fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }
log() { printf '[INFO] %s\n' "$*"; }

case "${1:-install}" in
  -h|--help|help) usage; exit ;;
  install) [[ $# -lt 2 ]] || fail 'install 不接受位置参数。' ;;
  *) usage >&2; exit 2 ;;
esac

root="${DEPLOY_ROOT:-/opt/xiaotai-flasher}"
repo_url="${REPO_URL:-https://github.com/tangeai/xiaotai-flasher.git}"
branch="${REPO_BRANCH:-main}"
[[ "$root" = /* ]] || fail 'DEPLOY_ROOT 必须是绝对路径。'
for executable in git node npm tar flock; do
  command -v "$executable" >/dev/null || fail "缺少命令 $executable"
done
mkdir -p -- "$root"
root="$(cd -- "$root" && pwd -P)"
[[ "$root" != / ]] || fail 'DEPLOY_ROOT 不能是文件系统根目录。'
repo="$root/xiaotai-flasher"
config="$root/boards-source.json"
exec 9>"$root/deploy.lock"
flock -n 9 || fail '另一个安装或发布任务正在运行。'

stage="$(mktemp -d "$root/.install.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT

if [[ ! -e "$repo" && ! -L "$repo" ]]; then
  log "克隆源码到 $repo"
  git clone --branch "$branch" -- "$repo_url" "$stage/repository"
  [[ -f "$stage/repository/scripts/deploy-prod.sh" ]] || fail '源码缺少生产部署脚本。'
  mv -- "$stage/repository" "$repo"
else
  [[ -d "$repo/.git" && ! -L "$repo" ]] || fail "源码路径已占用：$repo"
  if [[ -n "${REPO_URL:-}" && "$(git -C "$repo" remote get-url origin)" != "$repo_url" ]]; then
    fail '已有源码仓库的 origin 与 REPO_URL 不一致。'
  fi
fi

if [[ ! -e "$config" && ! -L "$config" ]]; then
  node --input-type=module - "$repo/public/boards-source.json" "$stage/boards-source.json" "${BOARDS_URL:-}" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [template, output, override] = process.argv.slice(2);
const config = JSON.parse(readFileSync(template, 'utf8'));
config.boards_url = override || config.boards_url;
writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
NODE
  mv -- "$stage/boards-source.json" "$config"
else
  log "使用已有板卡目录配置 $config"
fi
install -m 0755 -- "$repo/scripts/deploy-prod.sh" "$stage/deploy-prod.sh"
mv -- "$stage/deploy-prod.sh" "$root/deploy-prod.sh"
exec 9>&-
DEPLOY_ROOT="$root" "$root/deploy-prod.sh" update
