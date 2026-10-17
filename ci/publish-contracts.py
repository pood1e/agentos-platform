"""Publish generated contracts and the deployment bundle at an immutable source revision."""

import gzip
import hashlib
import json
import os
import subprocess
from pathlib import Path

import requests

revision = os.environ["CI_COMMIT_SHA"]
root = Path("dist/contracts")
epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], text=True))
bundle = root / "deployment.tar.gz"
with bundle.open("wb") as target, gzip.GzipFile(fileobj=target, mode="wb", filename="", mtime=epoch) as compressed:
    content = subprocess.check_output(["git", "archive", "--format=tar", "HEAD", "deploy", "environments", "charts", "ci", "docs", "LICENSE"])
    compressed.write(content)
files = [bundle, *root.glob("*.whl")]
manifest = {
    "revision": revision,
    "version": json.loads(Path("package.json").read_text())["version"],
    "files": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
}
path = root / "manifest.json"
path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
files.append(path)
url = f'{os.environ["CI_API_V4_URL"]}/projects/{os.environ["CI_PROJECT_ID"]}/packages/generic/agentos-platform/{revision}'
with requests.Session() as session:
    session.headers["JOB-TOKEN"] = os.environ["CI_JOB_TOKEN"]
    for path in files:
        existing = session.get(f"{url}/{path.name}", timeout=60)
        if existing.status_code == 200:
            if hashlib.sha256(existing.content).digest() != hashlib.sha256(path.read_bytes()).digest():
                raise RuntimeError("Published artifact differs from its source revision")
            continue
        if existing.status_code != 404:
            existing.raise_for_status()
        with path.open("rb") as body:
            session.put(f"{url}/{path.name}", data=body, timeout=120).raise_for_status()
print(f"Published contracts and deployment bundle for {revision}")
