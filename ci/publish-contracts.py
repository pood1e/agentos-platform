"""Publish generated contracts and deployment sources without replacing an artifact."""

import gzip
import os
import subprocess
from pathlib import Path

from manifest import digest, manifest
from registry import Registry
from versions import versions

version = versions()
root = Path("dist/contracts")
epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], text=True))
os.utime("gen/authorization.json", (epoch, epoch))
bundle = root / "deployment.tar.gz"
with (
    bundle.open("wb") as target,
    gzip.GzipFile(fileobj=target, mode="wb", filename="", mtime=epoch) as compressed,
):
    compressed.write(
        subprocess.check_output(
            [
                "git",
                "archive",
                "--format=tar",
                "--add-file=gen/authorization.json",
                "HEAD",
                "deploy",
                "environments",
                "charts",
                "ci",
                "docs",
                "LICENSE",
                "mise.toml",
                "mise.lock",
            ]
        )
    )
files = [bundle, *root.glob("*.whl"), *root.glob("*.tgz")]
if not os.environ.get("CI_COMMIT_TAG") and os.environ.get("CI_COMMIT_BRANCH") != os.environ.get(
    "CI_DEFAULT_BRANCH"
):
    print("Contract build complete; branch artifacts remain in this pipeline")
else:
    registry = Registry("agentos-platform", version.semver)
    try:
        content = manifest(
            version,
            {
                path.name: (f"{registry.url}/{path.name}", digest(path.read_bytes()))
                for path in files
            },
        )
        # Check the completed manifest before uploading any file on a retry.
        previous = registry.get("manifest.json")
        if previous is not None and previous != content:
            raise ValueError("Published contracts belong to different artifacts or revision")
        for path in files:
            registry.put(path.name, path.read_bytes())
        registry.put("manifest.json", content)
        (root / "manifest.json").write_bytes(content)
    finally:
        registry.close()
    print(f"Published contracts {version.semver} from {version.revision}")
