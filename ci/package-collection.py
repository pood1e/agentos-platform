"""Package the reference deployment collection with the release of this source revision."""

import os
import shutil
import subprocess
from pathlib import Path

import yaml
from artifacts import reproducible
from versions import versions

version = versions()
root = Path(".cache/collection")
shutil.rmtree(root, ignore_errors=True)
shutil.copytree("deploy", root, ignore=shutil.ignore_patterns(".*", "__pycache__", "tests"))
shutil.copyfile("LICENSE", root / "LICENSE")
(root / "playbooks/deploy/files").mkdir()
shutil.copyfile("ci/cosign.pub", root / "playbooks/deploy/files/cosign.pub")
(root / "playbooks/charts/agentos").mkdir(parents=True)
shutil.copyfile("charts/agentos/values.yaml", root / "playbooks/charts/agentos/values.yaml")
metadata = root / "galaxy.yml"
collection = yaml.safe_load(metadata.read_text())
collection["version"] = version.semver
metadata.write_text(yaml.safe_dump(collection, sort_keys=False))
for name in ("deploy", "environments"):
    path = root / "playbooks" / name / "vars.yaml"
    variables = yaml.safe_load(path.read_text())
    variables.update(
        delivery_version=version.semver,
        delivery_revision=version.revision,
        agentos_image_registry=os.environ["CI_REGISTRY_IMAGE"],
    )
    path.write_text(yaml.safe_dump(variables, sort_keys=False))
subprocess.run(
    ["ansible-galaxy", "collection", "build", str(root), "--output-path", "dist", "--force"],
    check=True,
)
reproducible(Path(f"dist/agentos-platform-{version.semver}.tar.gz"))
print("Packaged collection", version.semver, version.revision)
