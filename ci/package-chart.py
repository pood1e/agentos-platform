"""Package deterministic charts using only images built from the current source."""

import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import yaml
from artifacts import images, replace_images, reproducible, run
from versions import versions

version, built = versions(), images()
root = Path(".cache/release-charts")
shutil.rmtree(root, ignore_errors=True)
shutil.copytree("charts", root, ignore=shutil.ignore_patterns("charts", "crds"))
for chart in sorted(root.iterdir()):
    metadata = chart / "Chart.yaml"
    if not metadata.exists():
        continue
    info = yaml.safe_load(metadata.read_text())
    if chart.name in ("agentos", "agentos-environment"):
        shutil.copytree("controller/config/crd/bases", chart / "crds")
    info.update(version=version.semver, appVersion=version.semver)
    info.setdefault("annotations", {}).update(
        {
            "org.opencontainers.image.revision": version.revision,
            "org.opencontainers.image.source": "https://github.com/pood1e/agentos-platform",
        }
    )
    for dependency in info.get("dependencies", []):
        if dependency["repository"].startswith("file://"):
            dependency["version"] = version.semver
    metadata.write_text(yaml.safe_dump(info, sort_keys=False))
    values_file = chart / "values.yaml"
    values = replace_images(
        (yaml.safe_load(values_file.read_text()) or {}) if values_file.exists() else {}, built
    )
    if chart.name == "agentos":
        repository, digest = built[""].split("@", 1)
        values["image"] = {"repository": repository, "digest": digest}
        values["web"]["image"] = built["/web"]
    values_file.write_text(yaml.safe_dump(values, sort_keys=False))
    (chart / "Chart.lock").unlink(missing_ok=True)
for chart in sorted(root.iterdir()):
    if not (chart / "Chart.yaml").exists():
        continue
    subprocess.run(["helm", "dependency", "update", str(chart), "--skip-refresh"], check=True)
    lock = chart / "Chart.lock"
    if lock.exists():
        content = yaml.safe_load(lock.read_text())
        content["generated"] = datetime.fromtimestamp(
            int(run("git", "show", "-s", "--format=%ct", "HEAD")), UTC
        ).isoformat()
        lock.write_text(yaml.safe_dump(content, sort_keys=False))
    for dependency in (chart / "charts").glob("*.tgz"):
        reproducible(dependency)
    subprocess.run(["helm", "package", str(chart), "--destination", "dist"], check=True)
    reproducible(Path(f"dist/{chart.name}-{version.semver}.tgz"))
print("Packaged", version.semver, version.revision)
