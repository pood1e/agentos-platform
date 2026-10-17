"""Package generated Python contracts without copying operational configuration."""

import shutil
import subprocess
import sys
import os
from pathlib import Path

root = Path(__file__).resolve().parent.parent
target = root / ".cache/python-contracts"
if target.exists():
    shutil.rmtree(target)
subprocess.run([str(root / "node_modules/.bin/buf"), "generate", "--template", "buf.python.gen.yaml"], cwd=root, check=True)
shutil.copytree(root / "gen/python", target)
for name in ("LICENSE", "contracts/pyproject.toml"):
    shutil.copyfile(root / name, target / Path(name).name)
epoch = subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], cwd=root, text=True).strip()
subprocess.run([sys.executable, "-m", "build", "--wheel", "--outdir", str(root / "dist/contracts"), str(target)], env={**os.environ, "SOURCE_DATE_EPOCH": epoch}, check=True)
