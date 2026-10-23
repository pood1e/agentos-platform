"""Package generated Python contracts at the platform release version."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text())["version"]
epoch = subprocess.check_output(
    ["git", "show", "-s", "--format=%ct", "HEAD"], cwd=root, text=True
).strip()
subprocess.run([str(root / "ci/tools.sh"), "protoc"], cwd=root, check=True)
subprocess.run(
    [str(root / "node_modules/.bin/buf"), "generate", "--template", "buf.python.gen.yaml"],
    cwd=root,
    check=True,
)


def wheel(name, project, sources, requirements=""):
    target = root / ".cache" / f"python-{name}"
    if target.exists():
        shutil.rmtree(target)
    for destination, source in sources.items():
        shutil.copytree(
            source,
            target / destination,
            ignore=shutil.ignore_patterns("__pycache__"),
            dirs_exist_ok=True,
        )
    for path in (root / "LICENSE", project):
        shutil.copyfile(path, target / path.name)
    (target / "VERSION").write_text(version + "\n")
    if requirements:
        (target / "requirements.txt").write_text(requirements)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--outdir",
            str(root / "dist/contracts"),
            str(target),
        ],
        env={**os.environ, "SOURCE_DATE_EPOCH": epoch},
        check=True,
    )


wheel("contracts", root / "contracts/pyproject.toml", {".": root / "gen/python"})
subprocess.run([sys.executable, str(root / "ci/node-contracts.py")], cwd=root, check=True)
