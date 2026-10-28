"""Publish native Helm OCI artifacts, then sign immutable digests."""

import os
import subprocess
import tempfile
from pathlib import Path

from artifacts import descriptor, images, login, sign
from versions import versions

version = versions()
login()
registry = os.environ["CI_REGISTRY_IMAGE"]
for reference in images().values():
    sign(reference)
for archive in sorted(Path("dist").glob(f"*-{version.semver}.tgz")):
    name = archive.name.removesuffix(f"-{version.semver}.tgz")
    repository = registry + "/charts/" + name
    tagged = repository + ":" + version.semver.replace("+", "_")
    digest = descriptor(tagged)
    if digest:
        with tempfile.TemporaryDirectory() as target:
            subprocess.run(
                ["helm", "pull", "oci://" + repository + "@" + digest, "--destination", target],
                check=True,
            )
            (published,) = Path(target).glob("*.tgz")
            if published.read_bytes() != archive.read_bytes():
                raise ValueError("Published chart differs: " + name)
    else:
        subprocess.run(["helm", "push", str(archive), "oci://" + registry + "/charts"], check=True)
        digest = descriptor(tagged)
    sign(repository + "@" + digest)
