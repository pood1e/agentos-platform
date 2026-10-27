"""Publish contracts through the native GitLab npm and PyPI registries."""

import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import zipfile
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import requests
from versions import versions


class SimpleIndex(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.files = {}
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            url = urlsplit(href)
            self.files[unquote(url.path.rsplit("/", 1)[-1])] = parse_qs(url.fragment).get(
                "sha256", [None]
            )[0]


version = versions()
registry = f"{os.environ['CI_API_V4_URL']}/projects/{os.environ['CI_PROJECT_ID']}/packages"
token = os.environ["CI_JOB_TOKEN"]
package = next(Path("dist/contracts").glob("*.tgz"))
with tarfile.open(package) as archive:
    metadata = json.load(archive.extractfile("package/package.json"))
if metadata["version"] != version.semver or metadata["gitHead"] != version.revision:
    raise ValueError("npm package source differs")
with tempfile.TemporaryDirectory() as directory:
    config = Path(directory) / "npmrc"
    config.write_text(
        f"@agentos:registry={registry}/npm/\n//{registry.split('://', 1)[1]}/npm/:_authToken={token}\n"
    )
    config.chmod(0o600)
    env = {**os.environ, "NPM_CONFIG_USERCONFIG": str(config)}
    existing = subprocess.run(
        [
            "npm",
            "view",
            f"@agentos/contracts@{version.semver}",
            "--json",
        ],
        env=env,
        text=True,
        capture_output=True,
    )
    if existing.returncode == 0:
        previous = json.loads(existing.stdout)
        tarball = previous["dist"]["tarball"]
        if not tarball.startswith(registry + "/npm/"):
            raise ValueError("npm tarball registry differs")
        response = requests.get(tarball, headers={"Authorization": "Bearer " + token}, timeout=60)
        response.raise_for_status()
        if (
            hashlib.sha512(response.content).digest()
            != hashlib.sha512(package.read_bytes()).digest()
        ):
            raise ValueError("Published npm package differs")
    elif "E404" in existing.stderr:
        subprocess.run(
            [
                "npm",
                "publish",
                str(package),
                "--registry",
                registry + "/npm/",
                "--tag",
                "latest" if os.environ.get("CI_COMMIT_TAG") else "dev",
            ],
            env=env,
            check=True,
        )
    else:
        raise RuntimeError("npm registry lookup failed")
for wheel in Path("dist/contracts").glob("*.whl"):
    with zipfile.ZipFile(wheel) as archive:
        (metadata_path,) = [
            name for name in archive.namelist() if name.endswith(".dist-info/METADATA")
        ]
        metadata = BytesParser().parsebytes(archive.read(metadata_path))
    if (
        metadata["Version"] != version.python
        or f"Source, https://github.com/pood1e/agentos-platform/tree/{version.revision}"
        not in metadata.get_all("Project-URL", [])
    ):
        raise ValueError("Python package source differs")
    response = requests.get(
        registry + "/pypi/simple/agentos-contracts/", auth=("gitlab-ci-token", token), timeout=60
    )
    if response.status_code != 404:
        response.raise_for_status()
    checksum = hashlib.sha256(wheel.read_bytes()).hexdigest()
    files = SimpleIndex(response.text).files if response.status_code == 200 else {}
    if wheel.name in files:
        if files[wheel.name] != checksum:
            raise ValueError("Published Python package differs")
        continue
    subprocess.run(
        [
            "twine",
            "upload",
            "--non-interactive",
            "--repository-url",
            registry + "/pypi",
            str(wheel),
        ],
        env={**os.environ, "TWINE_USERNAME": "gitlab-ci-token", "TWINE_PASSWORD": token},
        check=True,
    )
