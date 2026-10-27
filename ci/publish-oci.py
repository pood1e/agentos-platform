"""Publish native Helm and Ansible OCI artifacts, then sign immutable digests."""

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
            if (Path(target) / archive.name).read_bytes() != archive.read_bytes():
                raise ValueError("Published chart differs: " + name)
    else:
        subprocess.run(["helm", "push", str(archive), "oci://" + registry + "/charts"], check=True)
        digest = descriptor(tagged)
    sign(repository + "@" + digest)
archive = Path(f"dist/agentos-platform-{version.semver}.tar.gz")
repository = registry + "/collections/platform"
tagged = repository + ":" + version.semver.replace("+", "_")
digest = descriptor(tagged)
if digest:
    with tempfile.TemporaryDirectory() as target:
        subprocess.run(["oras", "pull", repository + "@" + digest, "--output", target], check=True)
        if (Path(target) / archive.name).read_bytes() != archive.read_bytes():
            raise ValueError("Published collection differs")
else:
    subprocess.run(
        [
            "oras",
            "push",
            "--artifact-type",
            "application/vnd.ansible.collection.v1",
            "--annotation",
            "org.opencontainers.image.version=" + version.semver,
            "--annotation",
            "org.opencontainers.image.revision=" + version.revision,
            tagged,
            archive.name + ":application/gzip",
        ],
        cwd=archive.parent,
        check=True,
    )
    digest = descriptor(tagged)
sign(repository + "@" + digest)
