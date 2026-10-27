"""Exercise OCI verification against a disposable native registry."""

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

import yaml
from artifacts import replace_images

ROOT = Path(__file__).resolve().parent.parent


class SourceTest(unittest.TestCase):
    def test_missing_current_source_image_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Missing current-source"):
            replace_images({"image": "registry.example.com/agentos/worker:old"}, {})

    def test_recursive_native_images_use_build_digests(self):
        image = "registry.test/platform/worker@sha256:" + "a" * 64
        self.assertEqual(
            replace_images(
                {"spec": {"containers": [{"image": "registry.example.com/agentos/worker:old"}]}},
                {"/worker": image},
            ),
            {"spec": {"containers": [{"image": image}]}},
        )


class OCITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            cls.registry = "127.0.0.1:" + str(port.getsockname()[1])
        cls.process = subprocess.Popen(
            ["crane", "registry", "serve", "--address", cls.registry],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen("http://" + cls.registry + "/v2/", timeout=1).close()
                break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("Registry did not start")
        cls.env = {**os.environ, "COSIGN_PASSWORD": "test-only"}
        subprocess.run(
            ["cosign", "generate-key-pair", "--output-key-prefix", str(cls.root / "cosign")],
            env=cls.env,
            check=True,
            capture_output=True,
        )
        cls.version, cls.revision = "1.0.0", "a" * 40
        (cls.root / "artifact.txt").write_text("original")
        tagged = cls.registry + "/collection:1.0.0"
        cls.push(tagged)
        cls.digest = subprocess.check_output(
            ["oras", "resolve", "--plain-http", tagged], text=True
        ).strip()
        cls.reference = cls.registry + "/collection@" + cls.digest
        subprocess.run(
            [
                "cosign",
                "sign",
                "--yes",
                "--allow-http-registry",
                "--key",
                str(cls.root / "cosign.key"),
                "--signing-config",
                str(ROOT / "ci/signing-config.json"),
                "-a",
                "version=" + cls.version,
                "-a",
                "revision=" + cls.revision,
                cls.reference,
            ],
            env=cls.env,
            check=True,
            capture_output=True,
        )

    @classmethod
    def push(cls, tagged):
        subprocess.run(
            [
                "oras",
                "push",
                "--image-spec",
                "v1.0",
                "--plain-http",
                tagged,
                "artifact.txt:application/octet-stream",
            ],
            cwd=cls.root,
            check=True,
            capture_output=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.directory.cleanup()

    def verify(self, reference=None, version=None, revision=None):
        return subprocess.run(
            [
                "cosign",
                "verify",
                "--allow-http-registry",
                "--key",
                str(self.root / "cosign.pub"),
                "--insecure-ignore-tlog",
                "-a",
                "version=" + (version or self.version),
                "-a",
                "revision=" + (revision or self.revision),
                reference or self.reference,
            ],
            env=self.env,
            text=True,
            capture_output=True,
        )

    def test_clean_pull_and_repeat_convergence(self):
        self.assertEqual(self.verify().returncode, 0)
        for _ in range(2):
            with tempfile.TemporaryDirectory() as target:
                subprocess.run(
                    ["oras", "pull", "--plain-http", self.reference, "--output", target],
                    check=True,
                    capture_output=True,
                )
                self.assertEqual((Path(target) / "artifact.txt").read_text(), "original")

    def test_wrong_version_and_revision_are_rejected(self):
        self.assertNotEqual(self.verify(version="2.0.0").returncode, 0)
        self.assertNotEqual(self.verify(revision="b" * 40).returncode, 0)

    def test_tampered_tag_cannot_reuse_the_old_signature(self):
        (self.root / "artifact.txt").write_text("tampered")
        tagged = self.registry + "/collection:tampered"
        self.push(tagged)
        changed = subprocess.check_output(
            ["oras", "resolve", "--plain-http", tagged], text=True
        ).strip()
        self.assertNotEqual(
            self.verify(reference=self.registry + "/collection@" + changed).returncode, 0
        )

    def test_charts_and_collection_share_one_source_and_repackage_identically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("charts", "deploy", "environments", "roles", "ci"):
                shutil.copytree(
                    ROOT / name, root / name, ignore=shutil.ignore_patterns("charts", "__pycache__")
                )
            for name in ("package.json", ".release-please-manifest.json", "LICENSE"):
                shutil.copyfile(ROOT / name, root / name)
            (root / "gen").mkdir()
            (root / "gen/authorization.json").write_text("{}\n")
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.test",
                    "commit",
                    "-qm",
                    "baseline",
                ],
                cwd=root,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip()
            (root / "release-please-config.json").write_text(
                json.dumps({"bootstrap-sha": revision})
            )
            (root / ".cache").mkdir()
            (root / "dist/contracts").mkdir(parents=True)
            (root / "dist/contracts/agentos_contracts-1.0.0-py3-none-any.whl").write_bytes(
                b"fixture"
            )
            with tarfile.open(root / "layer.tar", "w"):
                pass
            registry = self.registry + "/platform"
            subprocess.run(
                [
                    "crane",
                    "append",
                    "--oci-empty-base",
                    "--new_layer",
                    str(root / "layer.tar"),
                    "--new_tag",
                    registry + ":base",
                ],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "crane",
                    "mutate",
                    "--label",
                    "org.opencontainers.image.revision=" + revision,
                    "--tag",
                    registry + ":" + revision,
                    registry + ":base",
                ],
                check=True,
                capture_output=True,
            )
            digest = subprocess.check_output(
                ["crane", "digest", registry + ":" + revision], text=True
            ).strip()
            suffixes = [
                "",
                "/web",
                "/platform-controller",
                "/voice",
                "/automation",
                "/kagent-controller",
                "/claude-harness",
                "/standard-harness",
                "/codex-harness",
                "/substrate/ateapi",
                "/substrate/ateworker-microvm",
            ]
            for index, suffix in enumerate(suffixes):
                reference = registry + suffix + ":" + revision
                if suffix:
                    subprocess.run(
                        ["crane", "copy", registry + ":" + revision, reference],
                        check=True,
                        capture_output=True,
                    )
                (root / f".cache/{index}-build-metadata.json").write_text(
                    json.dumps({"containerimage.digest": digest})
                )
                (root / f".cache/{index}-build-metadata.ref").write_text(reference)
            env = {
                **os.environ,
                "CI_REGISTRY_IMAGE": registry,
                "CI_COMMIT_SHA": revision,
                "CI_COMMIT_TAG": "",
            }
            previous = None
            for _ in range(2):
                result = subprocess.run(
                    [sys.executable, "ci/package-chart.py"],
                    cwd=root,
                    env=env,
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                artifacts = {
                    p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in (root / "dist").glob("*.*")
                    if p.is_file()
                }
                self.assertEqual(len(artifacts), 5)
                if previous is not None:
                    self.assertEqual(artifacts, previous)
                previous = artifacts
            for path in (root / ".cache/release-charts").glob("*/Chart.yaml"):
                self.assertEqual(
                    yaml.safe_load(path.read_text())["annotations"][
                        "org.opencontainers.image.revision"
                    ],
                    revision,
                )
            values = yaml.safe_load((root / ".cache/release-charts/agentos/values.yaml").read_text())
            self.assertEqual(values["web"]["image"], registry + "/web@" + digest)
            for path in (root / ".cache/collection/playbooks").glob("*/vars.yaml"):
                self.assertEqual(yaml.safe_load(path.read_text())["delivery_revision"], revision)


if __name__ == "__main__":
    unittest.main()
