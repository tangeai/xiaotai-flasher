#!/usr/bin/env python3
"""从 GitHub Release 同步完整固件，生成独立的本地目录快照。"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

REPOS = ("tangeai/xiaotai-esp32", "tangeai/xiaotai", "tangeai/xiaotai-lierda")
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "board-catalog"


@dataclass(frozen=True)
class Board:
    slug: str
    model: str
    chip: str
    stem: str = ""
    aliases: tuple = ()

    @property
    def platform(self):
        if self.chip.startswith("ESP32"):
            return "esp32"
        return "bk7258" if self.chip == "BK7258" else "lierda"

    @property
    def suffix(self):
        return {"esp32": "_merged.bin", "bk7258": "_all-app.bin", "lierda": ".binpkg"}[self.platform]

    def new_row(self):
        row = dict(slug=self.slug, model=self.model, chip=self.chip, platform=self.platform, releases=[])
        if self.platform == "lierda":
            if self.chip == "EC718HM":
                row.update(flash_bytes=8388608, modem="NT26F9D0", modempkg="F9D_D")
            else:
                row.update(flash_bytes=4194304, modem="NT26F6D0", modempkg="F6D_D")
        elif self.platform == "bk7258":
            row["flash_bytes"] = 8388608
        return row


BOARDS = (
    Board("lckfb-esp32s3", "立创实战派开发板 · ESP32-S3", "ESP32-S3", aliases=("szpi-s3",)),
    Board("m5stack-esp32s3-cores3-lite", "M5Stack开发板 · ESP32-S3(CoreS3-Lite)", "ESP32-S3",
          aliases=("m5stack-cores3-lite", "cores3-lite", "m5stack-cores3-lite_ili9342c")),
    Board("waveshare-p4-3.5", "微雪开发板 · ESP32-P4(3.5寸屏)", "ESP32-P4",
          "waveshare-esp32p4-3.5", ("waveshare-p4-rev3",)),
    Board("waveshare-p4-4.3", "微雪开发板 · ESP32-P4(4.3寸屏)", "ESP32-P4",
          "waveshare-esp32p4-4.3", ("waveshare-esp32p4-touch-lcd-43c-v10",)),
    Board("qiming-esp32p4", "启明开发板 · ESP32-P4", "ESP32-P4", aliases=("wt99p461-s1-1v1",)),
    Board("xmini-esp32c3", "Xmini-esp32c3 · ESP32-C3", "ESP32-C3", aliases=("xmini-c3-v3",)),
    Board("sibo-esp32c3", "四博-ESP32-C3", "ESP32-C3", aliases=("mz28-ai-ppd-v12", "mz28")),
    Board("esp32s31", "ESP32S31", "ESP32-S31", "eps32s31", ("jc1060f570c",)),
    Board("lckfb-bk7258", "立创实战派开发板 · BK7258", "BK7258"),
    Board("mgkfb-bk7258", "觅感 AI 玩具开发板 · BK7258（双屏眼睛）", "BK7258"),
    Board("lierda-ec718pm-lite", "EC718PM-Lite语音板", "EC718PM"),
    Board("lierda-ec718pm-pro", "EC718PM-Pro语音板", "EC718PM"),
    Board("lierda-ec718hm-pro", "EC718HM-Pro视频板", "EC718HM"),
)
BY_NAME = {key: board for board in BOARDS for key in (board.slug, board.stem, *board.aliases) if key}
VERSION = r"[0-9]+\.[0-9]+\.[0-9]+"
IDF = r"[0-9]+(?:\.[0-9]+)*"
MODERN = re.compile(rf"v({VERSION})[_-](.+?)(?:_idf({IDF}))?(_merged\.bin|_all-app\.bin|\.binpkg)")
FULL = re.compile(rf"xiaotai-(.+?)(?:-app)?-v?({VERSION})(?:-idf({IDF}))?-full-[0-9]+MB\.bin")


def identify(repo, release, name):
    idf = None
    if match := MODERN.fullmatch(name):
        version, key, idf, suffix = match.groups()
    elif match := FULL.fullmatch(name):
        key, version, idf = match.groups()
        suffix = "_merged.bin"
    elif match := re.fullmatch(r"\d{4}(?:_\d{2}){5}_(lite|pro)\.binpkg", name):
        kind = match[1]
        tag = re.fullmatch(rf"(?:lite-)?v?({VERSION})", release["tag_name"])
        if not tag or (kind == "pro" and release["tag_name"] != "0.2.0"):
            return None
        key, version, suffix = "lierda-ec718pm-" + kind, tag[1], ".binpkg"
    else:
        return None
    board = BY_NAME.get(key)
    if not board or suffix != board.suffix:
        return None
    if repo == REPOS[0] and board.platform != "esp32":
        return None
    if (repo == REPOS[2]) != (board.platform == "lierda"):
        return None
    # Old default full images omit the IDF suffix. Their release table lists
    # the exact SDK version in a cell on the same row as the full filename.
    for row in (release.get("body") or "").splitlines():
        if row.startswith("|") and f"`{name}`" in row:
            documented = re.search(rf"\|\s*({VERSION})\s*\|", row)
            if documented and (not idf or documented[1].startswith(idf + ".") or idf == documented[1]):
                idf = documented[1]
                break
    rank = tuple(map(int, (idf or "0").split(".")))
    return board, version, rank


def fetch(url, consume, *, api=False):
    headers = {"User-Agent": "xiaotai-firmware-sync"}
    if api and os.getenv("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=90) as response:
                return consume(response)
        except (HTTPError, URLError, TimeoutError, ConnectionError, IncompleteRead) as error:
            if attempt == 2 or isinstance(error, HTTPError) and error.code < 500 and error.code != 429:
                raise RuntimeError(f"{url}：{error}") from error
            print(f"读取中断，重试 {url}：{error}", file=sys.stderr)
            time.sleep(attempt + 1)


def list_releases(repo):
    releases = []
    page = 1
    while True:
        url = f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}"
        batch = fetch(url, json.load, api=True)
        releases.extend(batch)
        if len(batch) < 100:
            return releases
        page += 1


@dataclass
class Image:
    board: Board
    version: str
    idf: tuple
    asset: dict
    repo: str
    tag: str

    @property
    def filename(self):
        return f"v{self.version}_{self.board.stem or self.board.slug}{self.board.suffix}"

    @property
    def digest(self):
        return self.asset["digest"][7:].lower()


def select_images(repo, releases):
    published = sorted((r for r in releases if not r["draft"] and not r["prerelease"]),
                       key=lambda r: r["published_at"], reverse=True)
    selected = {}
    for release in published[:1]:
        for asset in release["assets"]:
            name = asset["name"]
            if not name.lower().endswith((".bin", ".binpkg")):
                continue
            identity = identify(repo, release, name)
            tag = release["tag_name"]
            if not identity:
                print(f"跳过未匹配的固件 {repo}/{tag}/{name}", file=sys.stderr)
                continue
            image = Image(*identity, asset, repo, tag)
            previous = selected.get(image.filename)
            if previous and image.idf == previous.idf and tag == previous.tag:
                raise ValueError(f"{repo}/{tag} 同一板型、版本和 IDF 存在多个附件：{name}")
            if not previous or image.idf > previous.idf:
                selected[image.filename] = image
    return selected.values()


def verified(path, image):
    if not path.is_file() or path.stat().st_size != image.asset["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == image.digest


def mirror(image, previous, firmware, stage):
    target = firmware / image.filename
    if verified(target, image):
        return False
    if target.exists():
        raise ValueError(f"已存在同名但内容不同的文件：{target}")
    local = previous.get("bin_url", "")
    candidates = []
    if re.fullmatch(r"\./firmware/[\w.+-]+", local):
        candidates.append(firmware / Path(local).name)
    if image.board.slug == "m5stack-esp32s3-cores3-lite":
        candidates.append(firmware / f"v{image.version}_m5stack-cores3-lite_merged.bin")
    ready = next((path for path in candidates if verified(path, image)), None)
    if ready is None:
        ready = stage / image.filename

        def download(response):
            with ready.open("wb") as stream:
                shutil.copyfileobj(response, stream, length=1024 * 1024)
            if ready.stat().st_size != image.asset["size"]:
                raise IncompleteRead(b"")

        print(f"下载 {image.asset['name']} → {image.filename}", flush=True)
        fetch(image.asset["browser_download_url"], download)
        if not verified(ready, image):
            raise ValueError(f"固件 SHA-256 校验失败：{image.filename}")
    try:
        os.link(ready, target)
        return True
    except FileExistsError:
        if not verified(target, image):
            raise ValueError(f"同名文件冲突：{target}")
        return False


def restore_archived_board(board, entries, firmware, stage):
    """Recover a catalogued C3 full image when upstream no longer lists the board."""
    releases = []
    for digest, old in entries.items():
        name = Path(old["bin_url"]).name
        identity = identify(REPOS[0], {"tag_name": ""}, name)
        if not identity or identity[0] != board or old["status"] != "published":
            continue
        filename = f"v{identity[1]}_{board.slug}{board.suffix}"
        target = firmware / filename
        candidates = [target, firmware / name]
        archives = firmware.parent.parent / "releases"
        candidates.extend(sorted(archives.glob("**/firmware/" + name)))
        for path in candidates:
            if not path.is_file():
                continue
            asset = {"size": path.stat().st_size, "digest": "sha256:" + digest}
            image = Image(*identity, asset, REPOS[0], "")
            if not verified(path, image):
                if path == target:
                    raise ValueError(f"已存在同名但内容不同的文件：{target}")
                print(f"跳过摘要不符的归档 {path}", file=sys.stderr)
                continue
            if path != target:
                ready = stage / filename
                shutil.copyfile(path, ready)
                if not verified(ready, image):
                    raise ValueError(f"归档复制校验失败：{path}")
                try:
                    os.link(ready, target)
                except FileExistsError:
                    if not verified(target, image):
                        raise ValueError(f"同名文件冲突：{target}")
                print(f"从本地归档恢复 {path.name} → {filename}")
            source_url = old.get("source_url") or old["bin_url"]
            tag, _, repository = old["version"].partition(" · ")
            if "source_url" not in old and repository in ("xiaotai-esp32", "xiaotai-esp32（测试版）"):
                source_url = f"https://github.com/{REPOS[0]}/releases/download/{quote(tag, safe='')}/{quote(name)}"
            releases.append(dict(old, bin_url="./firmware/" + filename, source_url=source_url))
            break
        else:
            print(f"找不到通过校验的本地归档 {name}", file=sys.stderr)
    return releases


def sync(directory, releases_for=list_releases):
    source = json.loads((directory / "boards.json").read_text(encoding="utf-8-sig"))
    boards, history = {}, {}
    for old in source["boards"]:
        board = BY_NAME.get(old["slug"])
        if not board:
            print("跳过未匹配的本地板型 " + old["slug"], file=sys.stderr)
            continue
        if board.slug in boards or old["chip"] != board.chip:
            raise ValueError("本地板型重复或芯片不一致：" + old["slug"])
        boards[board.slug] = dict(old, slug=board.slug, model=board.model, releases=[])
        history[board.slug] = {entry["sha256"]: entry for entry in old["releases"]}

    firmware = directory / "firmware"
    firmware.mkdir(exist_ok=True)
    jobs = {}
    for repo in REPOS:
        for image in select_images(repo, releases_for(repo)):
            asset, board = image.asset, image.board
            if image.filename in jobs:
                print(f"同名版本已由优先仓库提供，跳过 {repo}/{image.tag}/{asset['name']}", file=sys.stderr)
                continue
            url = f"https://github.com/{repo}/releases/download/{quote(image.tag, safe='')}/{quote(asset['name'])}"
            if (asset["state"] != "uploaded" or not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", asset.get("digest") or "")
                    or asset["browser_download_url"] != url or not 0 < asset["size"] <= 128 * 1024 * 1024):
                raise ValueError(f"无效的 Release 附件信息：{repo}/{image.tag}/{asset['name']}")
            old = history.get(board.slug, {}).get(image.digest, {})
            row = boards.setdefault(board.slug, board.new_row())
            version = f"v{image.version} · {repo.split('/')[1]}"
            entry = dict(old, version=version, status=old.get("status", "published"),
                         bin_url="./firmware/" + image.filename, source_url=asset["browser_download_url"], sha256=image.digest)
            entry.pop("recommended", None)
            if board.platform == "lierda":
                entry.update(version=image.version, source_filename=asset["name"], byte_length=asset["size"])
            row["releases"].append(entry)
            jobs[image.filename] = (image, old)

    for row in boards.values():
        for entry in row["releases"]:
            if entry["status"] == "published":
                entry["recommended"] = True
                break
    with tempfile.TemporaryDirectory(dir=directory, prefix=".sync-") as tmp:
        stage = Path(tmp)
        with ThreadPoolExecutor(max_workers=4) as pool:
            tasks = [pool.submit(mirror, image, old, firmware, stage) for image, old in jobs.values()]
            restored = sum(task.result() for task in tasks)
        for slug in ("xmini-esp32c3", "sibo-esp32c3"):
            row = boards.get(slug)
            if row and not row["releases"]:
                row["releases"] = restore_archived_board(BY_NAME[slug], history[slug], firmware, stage)
        count = sum(len(row["releases"]) for row in boards.values())
        if not count:
            raise ValueError("没有匹配的固件。")
        catalog = dict(source, boards=list(boards.values()))
        snapshots = sorted(directory.glob("boards-????-??-??T??-??-??.*Z.json"))
        if snapshots:
            latest = snapshots[-1]
            try:
                unchanged = json.loads(latest.read_text(encoding="utf-8-sig")) == catalog
            except (UnicodeError, json.JSONDecodeError):
                unchanged = False
            if unchanged:
                if restored:
                    print(f"已补齐 {restored} 个缺失的固件，复用 {latest}。")
                else:
                    print(f"固件和目录已是最新，复用 {latest}。")
                return latest
        staged = stage / "boards.json"
        staged.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S.%fZ")
        snapshot = directory / f"boards-{stamp}.json"
        os.link(staged, snapshot)
    print(f"已生成 {snapshot}，包含 {count} 个固件。")
    return snapshot


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-dir", type=Path, default=DEFAULT_DIR, help="含 boards.json 的本地目录")
    try:
        sync(parser.parse_args().catalog_dir.resolve())
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        sys.exit(f"同步失败：{error}")
