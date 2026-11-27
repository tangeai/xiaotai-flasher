import hashlib
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import BytesIO, StringIO
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_firmware as sync


DATA = b"firmware"
DIGEST = hashlib.sha256(DATA).hexdigest()


def release(repo, tag, *names, date="2026-11-20", body=""):
    assets = [dict(name=name, state="uploaded", size=len(DATA), digest="sha256:" + DIGEST,
                   browser_download_url=f"https://github.com/{repo}/releases/download/{tag}/{name}")
              for name in names]
    return dict(tag_name=tag, published_at=date, draft=False, prerelease=False, assets=assets, body=body)


class FirmwareSyncTests(unittest.TestCase):
    def test_latest_idf_and_unmatched_log(self):
        repo = sync.REPOS[0]
        default = "xiaotai-cores3-lite-v1.2.3-full-16MB.bin"
        newest = "v1.2.3_waveshare-p4-rev3_idf6.10_merged.bin"
        data = release(repo, "v1.2.3", newest, "v1.2.3_waveshare-p4-rev3_idf6.9_merged.bin",
                       default, "xiaotai-cores3-lite-v1.2.3-idf5.5-full-16MB.bin", "unknown.bin",
                       body=f"| M5 | 6.0.3 | `{default}` |")
        logs = StringIO()
        with redirect_stderr(logs):
            images = list(sync.select_images(repo, [data]))
        self.assertEqual([i.asset["name"] for i in images], [newest, default])
        self.assertIn("unknown.bin", logs.getvalue())

    def test_v040_s3_board_slugs_and_storage_names(self):
        repo = sync.REPOS[0]
        data = release(repo, "v0.4.0", "v0.4.0_szpi-s3_idf6.0_merged.bin", "v0.4.0_cores3-lite_idf6.0_merged.bin")
        self.assertEqual([(i.board.slug, i.filename) for i in sync.select_images(repo, [data])], [
            ("lckfb-esp32s3", "v0.4.0_lckfb-esp32s3_merged.bin"),
            ("m5stack-esp32s3-cores3-lite", "v0.4.0_m5stack-esp32s3-cores3-lite_merged.bin"),
        ])

    def test_qiming_alias_across_idf_builds(self):
        repo = sync.REPOS[0]
        older = "v0.4.0_wt99p461-s1-1v1_idf5.5_merged.bin"
        newer = "v0.4.0_wt99p461-s1-1v1_idf6.0_merged.bin"
        for names, expected in [([older], older), ([older, newer], newer)]:
            with self.subTest(names=names):
                image, = sync.select_images(repo, [release(repo, "v0.4.0", *names)])
                self.assertEqual(image.board.slug, "qiming-esp32p4")
                self.assertEqual(image.filename, "v0.4.0_qiming-esp32p4_merged.bin")
                self.assertEqual(image.asset["name"], expected)

    def test_filenames(self):
        cases = [
            (0, "xiaotai-xmini-c3-v3-app-v0.1.0-full-16MB.bin", "v0.1.0_xmini-esp32c3_merged.bin"),
            (0, "xiaotai-mz28-1.0.0-full-8MB.bin", "v1.0.0_sibo-esp32c3_merged.bin"),
            (0, "v0.4.0_jc1060f570c_idf6.1_merged.bin", "v0.4.0_eps32s31_merged.bin"),
            (0, "v2.0.0_eps32s31_merged.bin", "v2.0.0_eps32s31_merged.bin"),
            (2, "v0.1.0-lierda-ec718hm-pro.binpkg", "v0.1.0_lierda-ec718hm-pro.binpkg"),
            (2, "2026_10_11_21_26_44_pro.binpkg", "v0.2.0_lierda-ec718pm-pro.binpkg"),
        ]
        for index, name, expected in cases:
            with self.subTest(name=name):
                repo = sync.REPOS[index]
                image, = sync.select_images(repo, [release(repo, "0.2.0", name)])
                self.assertEqual(image.filename, expected)

    def test_archive_recovery_and_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "board-catalog"
            root.mkdir()
            archive = Path(tmp) / "releases" / "backup" / "firmware"
            archive.mkdir(parents=True)
            name = "xiaotai-xmini-c3-v3-app-v0.1.0-full-16MB.bin"
            file = archive / name
            file.write_bytes(b"incorrect")
            entry = dict(version="xmini-c3-v3-app-v0.1.0 · xiaotai-esp32（测试版）", status="published", sha256=DIGEST, bin_url="./firmware/" + name)
            board = dict(slug="xmini-c3-v3", chip="ESP32-C3", platform="esp32", releases=[entry])
            (root / "boards.json").write_text(json.dumps(dict(boards=[board])))
            with self.assertRaisesRegex(ValueError, "没有匹配"):
                sync.sync(root, lambda repo: [])
            file.write_bytes(DATA)
            snapshot = sync.sync(root, lambda repo: [])
            row, = json.loads(snapshot.read_text())["boards"]
            self.assertEqual(row["slug"], "xmini-esp32c3")
            saved, = row["releases"]
            self.assertEqual(saved["version"], entry["version"])
            self.assertEqual(saved["source_url"], "https://github.com/tangeai/xiaotai-esp32/releases/download/xmini-c3-v3-app-v0.1.0/" + name)
            self.assertEqual(saved["bin_url"], "./firmware/v0.1.0_xmini-esp32c3_merged.bin")
            self.assertEqual((root / saved["bin_url"]).read_bytes(), DATA)
            (root / "boards.json").write_bytes(snapshot.read_bytes())
            (root / saved["bin_url"]).unlink()
            self.assertEqual(sync.sync(root, lambda repo: []), snapshot)
            self.assertEqual((root / saved["bin_url"]).read_bytes(), DATA)
            file.unlink()
            self.assertEqual(sync.sync(root, lambda repo: []), snapshot)

    def test_downloads_only_the_latest_published_release(self):
        repo = sync.REPOS[0]
        def make(tag, date):
            return release(repo, tag, f"{tag}_szpi-s3_idf6.0_merged.bin", date=date)

        latest = make("v0.4.0", "2026-11-20")
        releases = [dict(make("v0.6.0", "2026-11-24"), draft=True),
                    make("v0.3.1", "2026-11-19"), latest,
                    dict(make("v0.5.0", "2026-11-23"), prerelease=True)]
        def fetch(url, consume):
            consume(BytesIO(DATA))

        with tempfile.TemporaryDirectory() as tmp, patch.object(sync, "fetch", side_effect=fetch) as network:
            root = Path(tmp)
            (root / "boards.json").write_text(json.dumps({"boards": []}))
            releases_for = lambda source: releases if source == repo else []
            snapshot = sync.sync(root, releases_for)
            board, = json.loads(snapshot.read_text())["boards"]
            entry, = board["releases"]
            self.assertEqual(entry["source_url"], latest["assets"][0]["browser_download_url"])
            self.assertEqual(network.call_count, 1)
            network.reset_mock()
            self.assertEqual(sync.sync(root, releases_for), snapshot)
            network.assert_not_called()

    def test_failed_download_preserves_snapshot_and_can_be_retried(self):
        repo = sync.REPOS[0]
        tag = "v1.2.3"
        name = tag + "_qiming-esp32p4_merged.bin"
        def releases(source):
            return [release(repo, tag, name)] if source == repo else []

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "boards.json"
            source.write_text('{"boards":[]}')
            previous = root / "boards-2026-01-01T00-00-00.000000Z.json"
            previous.write_bytes(source.read_bytes())
            for payload, error in [(b"", sync.IncompleteRead), (b"x" * len(DATA), ValueError)]:
                with self.subTest(payload=payload), patch.object(sync, "fetch", lambda url, consume: consume(BytesIO(payload))):
                    with self.assertRaises(error):
                        sync.sync(root, releases)
                    self.assertEqual(previous.read_bytes(), source.read_bytes())
                    self.assertEqual(list(root.glob("boards-*.json")), [previous])
                    self.assertEqual(list((root / "firmware").iterdir()), [])
            with patch.object(sync, "fetch", lambda url, consume: consume(BytesIO(DATA))):
                snapshot = sync.sync(root, releases)
            self.assertNotEqual(previous, snapshot)
            self.assertEqual((root / "firmware" / name).read_bytes(), DATA)

    def test_snapshot_priority_cache_and_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / "firmware"
            folder.mkdir()
            (folder / "old.bin").write_bytes(DATA)
            platforms = [{"platform": "custom", "platform_name": "保留"}]
            old = dict(sha256=DIGEST, bin_url="./firmware/old.bin", status="published")
            board = dict(platform="custom", platform_name="保留", slug="waveshare-p4-rev3",
                         chip="ESP32-P4", model="旧名", releases=[old])
            source = json.dumps(dict(platforms=platforms, boards=[board]))
            (root / "boards.json").write_text(source)
            name = "v1.2.3_waveshare-p4-rev3_merged.bin"

            def releases(repo):
                if repo == sync.REPOS[2]:
                    return []
                return [release(repo, "fourth", "v1.0.0_qiming-esp32p4_merged.bin", date="2025"),
                        release(repo, "second"), release(repo, "third"), release(repo, "v1.2.3", name, date="2027")]

            snapshot = sync.sync(root, releases)
            catalog = json.loads(snapshot.read_text())
            self.assertRegex(snapshot.name, r"^boards-\d{4}-\d{2}-\d{2}T.*\.json$")
            self.assertEqual((root / "boards.json").read_text(), source)
            self.assertEqual(catalog["platforms"], platforms)
            board, = catalog["boards"]
            self.assertEqual((board["platform"], board["platform_name"], board["slug"]), ("custom", "保留", "waveshare-p4-3.5"))
            item, = board["releases"]
            self.assertEqual(item["version"], "v1.2.3 · xiaotai-esp32")
            self.assertEqual(item["source_url"], f"https://github.com/{sync.REPOS[0]}/releases/download/v1.2.3/{name}")
            target = root / item["bin_url"]
            self.assertEqual(target.read_bytes(), DATA)
            self.assertEqual(sync.sync(root, releases), snapshot)
            self.assertEqual(list(root.glob("boards-*.json")), [snapshot])
            target.write_bytes(b"broken")
            with self.assertRaisesRegex(ValueError, "同名"):
                sync.sync(root, releases)
            self.assertEqual(list(root.glob("boards-*.json")), [snapshot])


if __name__ == "__main__":
    unittest.main()
