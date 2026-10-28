"""Verify release identity, stable development versions and immutable publication."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from packaging.version import Version
from versions import versions


class VersionsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        previous = Path.cwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous)
        self.environment = patch.dict(os.environ, {"CI_COMMIT_TAG": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        Path("package.json").write_text(json.dumps({"version": "0.26.5"}))
        Path(".github").mkdir()
        Path(".github/.release-please-manifest.json").write_text(json.dumps({".": "0.26.5"}))
        self.run_git("init", "-q")
        self.run_git("add", ".")
        self.run_git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-qm",
            "baseline",
        )
        self.baseline = self.run_git("rev-parse", "HEAD")
        Path(".github/release-please-config.json").write_text(
            json.dumps({"bootstrap-sha": self.baseline})
        )
        self.run_git("add", ".")
        self.run_git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-qm",
            "feat: next",
        )
        self.revision = self.run_git("rev-parse", "HEAD")
        os.environ["CI_COMMIT_SHA"] = self.revision

    def run_git(self, *args):
        return subprocess.check_output(["git", *args], text=True).strip()

    def test_development_versions_remain_stable_when_a_tag_is_added(self):
        expected = versions()
        self.assertEqual(expected.semver, f"0.27.0-dev.1.g{self.revision[:12]}")
        self.assertEqual(str(Version(expected.python)), f"0.27.0.dev1+g{self.revision[:12]}")
        self.run_git("tag", "v0.26.5")
        self.assertEqual(expected, versions())

    def test_checkout_and_pipeline_revisions_must_match(self):
        os.environ["CI_COMMIT_SHA"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "revisions differ"):
            versions()

    def test_unprotected_or_inconsistent_release_tags_fail(self):
        os.environ.update(CI_COMMIT_TAG="v0.26.5", CI_COMMIT_REF_PROTECTED="false")
        with self.assertRaisesRegex(ValueError, "protected"):
            versions()
        os.environ.update(CI_COMMIT_TAG="v0.27.0", CI_COMMIT_REF_PROTECTED="true")
        with self.assertRaisesRegex(ValueError, "package version"):
            versions()

    def test_release_tag_is_checked_against_the_github_revision(self):
        os.environ.update(CI_COMMIT_TAG="v0.26.5", CI_COMMIT_REF_PROTECTED="true")
        native = subprocess.check_output

        def output(args, **kwargs):
            if args[1] == "ls-remote":
                return f"{self.revision}\trefs/tags/v0.26.5\n"
            return native(args, **kwargs)

        with patch("versions.subprocess.check_output", side_effect=output):
            release = versions()
            self.assertEqual(release.semver, "0.26.5")
            self.assertEqual(release.python, "0.26.5")
        with patch("versions.git", side_effect=[self.revision, f"{'0' * 40}\trefs/tags/v0.26.5"]):
            with self.assertRaisesRegex(ValueError, "tag revisions"):
                versions()


if __name__ == "__main__":
    unittest.main()
