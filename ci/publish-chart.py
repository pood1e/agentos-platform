"""Publish immutable charts, then commit their release manifest."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from manifest import digest
from registry import Registry

subprocess.run([sys.executable, "ci/package-chart.py"], check=True)
content = Path("dist/release.json").read_bytes()
release = json.loads(content)
registry = Registry("agentos-release", release["version"])
helm = "helm"
try:
    previous = registry.get("release.json")
    if previous is not None and previous != content:
        raise ValueError("Published release has different artifacts or source revision")
    subprocess.run(
        [
            helm,
            "registry",
            "login",
            os.environ["CI_REGISTRY"],
            "--username",
            os.environ["CI_REGISTRY_USER"],
            "--password-stdin",
        ],
        input=os.environ["CI_REGISTRY_PASSWORD"],
        text=True,
        check=True,
        capture_output=True,
    )
    for name, artifact in release["artifacts"].items():
        if not artifact["location"].startswith("oci://"):
            continue
        with tempfile.TemporaryDirectory() as target:
            pulled = subprocess.run(
                [
                    helm,
                    "pull",
                    artifact["location"],
                    "--version",
                    release["version"],
                    "--destination",
                    target,
                ],
                text=True,
                capture_output=True,
            )
            filename = f"{name}-{release['version']}.tgz"
            if pulled.returncode == 0:
                if digest((Path(target) / filename).read_bytes()) != artifact["digest"]:
                    raise ValueError(f"Published chart differs: {name}")
            else:
                error = pulled.stderr.lower()
                if previous is not None or not any(
                    marker in error for marker in ["404", "not found", "manifest_unknown"]
                ):
                    raise RuntimeError(f"Chart lookup failed: {name}: {pulled.stderr}")
                subprocess.run(
                    [
                        helm,
                        "push",
                        f"dist/{filename}",
                        f"oci://{os.environ['CI_REGISTRY_IMAGE']}/charts",
                    ],
                    check=True,
                )
    registry.put("release.json", content)
finally:
    registry.close()
print("Published platform", release["version"], release["revision"])
