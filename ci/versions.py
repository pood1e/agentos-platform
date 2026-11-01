"""Map a source revision to SemVer and PEP 440 artifact versions."""

import json
import os
import re
import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Versions:
    revision: str
    semver: str
    python: str


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def versions():
    revision = git("rev-parse", "HEAD")
    if os.environ.get("CI_COMMIT_SHA", revision) != revision:
        raise ValueError("Pipeline and checkout revisions differ")
    current = json.loads(Path("package.json").read_text())["version"]
    tag = os.environ.get("CI_COMMIT_TAG", "")
    if tag:
        if tag != f"v{current}" or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
            raise ValueError("Release tag and package version differ")
        if os.environ.get("CI_COMMIT_REF_PROTECTED") != "true":
            raise ValueError("Formal releases require a protected tag")
        manifest = json.loads(Path(".github/.release-please-manifest.json").read_text())
        if manifest["."] != current:
            raise ValueError("Release manifest and package version differ")
        request = urllib.request.Request(
            f"https://api.github.com/repos/pood1e/agentos-platform/commits/{tag}",
            headers={"Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            github_revision = json.load(response)["sha"]
        if github_revision != revision:
            raise ValueError("GitHub and GitLab release tag revisions differ")
        return Versions(revision, current, current)
    released = json.loads(Path(".github/.release-please-manifest.json").read_text())["."]
    baseline = json.loads(Path(".github/release-please-config.json").read_text())["bootstrap-sha"]
    git("merge-base", "--is-ancestor", baseline, revision)
    count = int(git("rev-list", "--count", f"{baseline}..{revision}"))
    major, minor, _ = map(int, current.split("."))
    target = current if current != released else f"{major}.{minor + 1}.0"
    return Versions(
        revision, f"{target}-dev.{count}.g{revision[:12]}", f"{target}.dev{count}+g{revision[:12]}"
    )


if __name__ == "__main__":
    print(json.dumps(versions().__dict__, sort_keys=True))
