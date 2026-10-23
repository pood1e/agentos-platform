"""Package deterministic charts and a typed release manifest for one source revision."""

import gzip
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import yaml

from manifest import digest as checksum, manifest
from versions import versions as source_versions

PLACEHOLDER = "registry.example.com/agentos"
chart = Path("charts/agentos")
registry = os.environ["CI_REGISTRY_IMAGE"]
version = source_versions()
package = json.loads(Path("package.json").read_text())
console_digest = json.loads(Path(".cache/build-metadata.json").read_text())["containerimage.digest"]
info = yaml.safe_load((chart / "Chart.yaml").read_text())
assert info["appVersion"] == info["version"] == package["version"]
values = yaml.safe_load((chart / "values.yaml").read_text())
versions = yaml.safe_load(Path("deploy/vars.yaml").read_text())
harnesses = values["harnesses"]
assert harnesses["memory"]["workload"]["image"] == harnesses["standard"]["workload"]["image"]
pins = {
    "controller": versions["kagent_controller_image"],
    "substrate-api": versions["substrate_api_image"],
    "substrate-microvm": versions["substrate_microvm_image"],
    "claude-harness": harnesses["claude"]["workload"]["image"],
    "standard-harness": harnesses["standard"]["workload"]["image"],
    "codex-harness": harnesses["codex"]["workload"]["image"],
}
for name, image in pins.items():
    image_metadata = Path(f".cache/{name}-build-metadata.json")
    if image_metadata.exists():
        built_digest = json.loads(image_metadata.read_text())["containerimage.digest"]
        assert image.endswith("@" + built_digest), (
            f"Published {name} image differs from the deployment pin"
        )


def published(image):
    for prefix in (PLACEHOLDER + "/", "{{ agentos_image_registry }}/"):
        if image.startswith(prefix):
            return registry + "/" + image.removeprefix(prefix)
    raise AssertionError(f"{image} is not a platform image")


images = {name: published(image) for name, image in pins.items()}
images["image"] = f"{registry}@{console_digest}"
for name in ("automation", "voice"):
    built = json.loads(Path(f".cache/{name}-build-metadata.json").read_text())[
        "containerimage.digest"
    ]
    images[name] = f"{registry}/{name}@{built}"
for image in images.values():
    value = image.split("@", 1)[1]
    assert value.startswith("sha256:") and len(value) == 71
values["image"] = {"repository": registry, "digest": console_digest}
for harness in harnesses.values():
    harness["workload"]["image"] = published(harness["workload"]["image"])
values["voice"]["image"] = images["voice"]
artifacts = {name: (image, image.split("@", 1)[1]) for name, image in images.items()}
epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], text=True))
for source in sorted(Path("charts").iterdir()):
    if not (source / "Chart.yaml").exists():
        continue
    target = Path(".cache/release-charts") / source.name
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(source, target)
    metadata = yaml.safe_load((target / "Chart.yaml").read_text())
    assert metadata["version"] == metadata["appVersion"] == package["version"]
    metadata.update(version=version.semver, appVersion=version.semver)
    (target / "Chart.yaml").write_text(yaml.safe_dump(metadata, sort_keys=False))
    if source == chart:
        (target / "values.yaml").write_text(yaml.safe_dump(values, sort_keys=False))
    subprocess.run(["helm", "package", str(target), "--destination", "dist"], check=True)
    archive = Path(f"dist/{source.name}-{version.semver}.tgz")
    original = tarfile.open(archive)
    members = [
        (item, original.extractfile(item).read() if item.isfile() else None)
        for item in original.getmembers()
    ]
    original.close()
    with (
        archive.open("wb") as output,
        gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=epoch) as compressed,
        tarfile.open(fileobj=compressed, mode="w") as packed,
    ):
        for item, content in sorted(members, key=lambda member: member[0].name):
            item.mtime, item.uid, item.gid, item.uname, item.gname = epoch, 0, 0, "", ""
            packed.addfile(item, io.BytesIO(content) if content is not None else None)
    artifacts[source.name] = (
        f"oci://{registry}/charts/{source.name}",
        checksum(archive.read_bytes()),
    )
contracts = Path("dist/contracts/manifest.json")
if contracts.exists():
    artifacts["contracts"] = (
        f"{os.environ['CI_API_V4_URL']}/projects/{os.environ['CI_PROJECT_ID']}/packages/generic/agentos-platform/{version.semver}/manifest.json",
        checksum(contracts.read_bytes()),
    )
Path("dist/release.json").write_bytes(manifest(version, artifacts))
print("Packaged platform", version.semver, version.revision)
