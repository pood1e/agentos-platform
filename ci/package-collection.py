"""Build the reference deployment as an Ansible collection."""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import yaml
from artifacts import images, replace_images, reproducible
from versions import versions

version, built = versions(), images()
root = Path(".cache/collection")
shutil.rmtree(root, ignore_errors=True)
for name in ("deploy", "environments"):
    shutil.copytree(name, root / "playbooks" / name, ignore=shutil.ignore_patterns("__pycache__"))
shutil.copyfile("LICENSE", root / "LICENSE")
shutil.copyfile("deploy/collection-README.md", root / "README.md")
(root / "playbooks/gen").mkdir(parents=True)
shutil.copyfile("gen/authorization.json", root / "playbooks/gen/authorization.json")
for name in ("deploy", "environments"):
    variables = root / "playbooks" / name / "vars.yaml"
    values = replace_images(yaml.safe_load(variables.read_text()), built)
    values.update(delivery_version=version.semver, delivery_revision=version.revision)
    values["agentos_image_registry"] = os.environ["CI_REGISTRY_IMAGE"]
    values["app_chart_version" if name == "deploy" else "environment_chart_version"] = (
        version.semver
    )
    values["app_chart_repository" if name == "deploy" else "environment_chart_repository"] = (
        "oci://" + os.environ["CI_REGISTRY_IMAGE"] + "/charts"
    )
    variables.write_text(yaml.safe_dump(values, sort_keys=False))
(root / "playbooks/charts/agentos").mkdir(parents=True)
shutil.copyfile(
    ".cache/release-charts/agentos/values.yaml", root / "playbooks/charts/agentos/values.yaml"
)
hashes = [
    f"agentos-contracts=={version.python} --hash=sha256:{hashlib.sha256(wheel.read_bytes()).hexdigest()}"
    for wheel in Path("dist/contracts").glob("agentos_contracts-*.whl")
]
if len(hashes) != 1:
    raise ValueError("Exactly one contracts wheel is required")
(root / "requirements-contracts.txt").write_text("\n".join(hashes) + "\n")
for name in ("deploy", "environments", "connections"):
    target = (
        "deploy/deploy.yaml"
        if name == "deploy"
        else "environments/" + ("deploy.yaml" if name == "environments" else "connections.yaml")
    )
    (root / "playbooks" / (name + ".yaml")).write_text(
        yaml.safe_dump([{"name": "AgentOS " + name, "ansible.builtin.import_playbook": target}])
    )
(root / "galaxy.yml").write_text(
    yaml.safe_dump(
        {
            "namespace": "agentos",
            "name": "platform",
            "version": version.semver,
            "readme": "README.md",
            "authors": ["AgentOS"],
            "description": "AgentOS reference deployment",
            "license": ["Apache-2.0"],
            "repository": "https://github.com/pood1e/agentos-platform",
            "issues": "https://github.com/pood1e/agentos-platform/issues",
            "tags": ["kubernetes"],
            "dependencies": {
                "kubernetes.core": "==6.6.0",
                "ansible.posix": "==2.2.2",
                "community.library_inventory_filtering": "==1.1.5",
                "community.general": "==13.4.0",
            },
        },
        sort_keys=False,
    )
)
subprocess.run(
    ["ansible-galaxy", "collection", "build", str(root), "--output-path", "dist", "--force"],
    check=True,
)
reproducible(Path(f"dist/agentos-platform-{version.semver}.tar.gz"))
