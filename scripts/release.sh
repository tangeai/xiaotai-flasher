#!/usr/bin/env bash
set -euo pipefail
umask 022

usage() {
  cat <<'HELP'
Usage: scripts/release.sh [--boards-url URL] [--output-dir DIR] [--deploy-dir DIR] [--skip-install]

  --boards-url URL   Override boards_url in the release package.
  --output-dir DIR   Directory for the .tar.gz package. Default: releases/ in the repo.
  --deploy-dir DIR   Optional local static-site path to publish via an atomic symlink.
  --skip-install    Build using the dependencies already installed in the repo.
  -h, --help        Show this help.
HELP
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

caller_dir="$PWD"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
boards_url=''
output_dir="$repo_dir/releases"
deploy_dir=''
skip_install=false

while (($#)); do
  case "$1" in
    --boards-url|--output-dir|--deploy-dir)
      [[ $# -gt 1 && -n "$2" && "$2" != --* ]] || fail "Missing value for $1"
      case "$1" in
        --boards-url) boards_url="$2" ;;
        --output-dir) output_dir="$2" ;;
        --deploy-dir) deploy_dir="$2" ;;
      esac
      shift 2
      ;;
    --skip-install) skip_install=true; shift ;;
    -h|--help) usage; exit ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ "$output_dir" = /* ]] || output_dir="$caller_dir/$output_dir"
if [[ -n "$deploy_dir" && "$deploy_dir" != /* ]]; then
  deploy_dir="$caller_dir/$deploy_dir"
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/xiaotai-flasher.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
site_dir="$work_dir/site"
release_name="xiaotai-flasher-$(date -u +%Y%m%dT%H%M%SZ)-${work_dir##*.}"

cd -- "$repo_dir"
source_commit=''
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [[ -z "$(git status --porcelain)" ]]; then
  source_commit="$(git rev-parse HEAD)"
fi
if ! "$skip_install"; then
  npm ci
fi
npm run build -- --outDir "$site_dir" --emptyOutDir
node "$repo_dir/scripts/site-release.mjs" verify "$site_dir" --require-lierda-agentboot || fail 'Release output is incomplete. Check the built entry and the bundled Lierda USB AgentBoot.'

node --input-type=module - "$site_dir/boards-source.json" "$boards_url" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [path, override] = process.argv.slice(2);
const config = JSON.parse(readFileSync(path, 'utf8'));
const value = override || config.boards_url;
let resolved;
if (typeof value === 'string' && value.trim()) {
  try {
    resolved = new URL(value, 'https://xiaotai.invalid/web-flasher/');
  } catch {}
}

if (!resolved || resolved.protocol !== 'https:' || resolved.username || resolved.password) {
  throw new Error('boards_url must be an HTTPS URL or a site-relative path.');
}

if (override) writeFileSync(path, JSON.stringify({ ...config, boards_url: override }, null, 2) + '\n');
NODE

if [[ -n "$source_commit" ]]; then
  printf '{"commit":"%s"}\n' "$source_commit" >"$site_dir/release-info.json"
fi

mkdir -p -- "$output_dir"
archive="$output_dir/$release_name.tar.gz"
temporary_archive="$output_dir/.$release_name.tar.gz"
if ! tar -czf "$temporary_archive" -C "$site_dir" .; then
  rm -f -- "$temporary_archive"
  fail 'Unable to write the release archive.'
fi
mv -- "$temporary_archive" "$archive"
printf 'Release archive: %s\n' "$archive"

if [[ -n "$deploy_dir" ]]; then
  node "$repo_dir/scripts/site-release.mjs" publish "$deploy_dir" "$release_name" "$site_dir"
fi
