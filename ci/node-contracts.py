"""Package public protobuf sources, generated clients, and shared policy utilities."""

import json
import shutil
import subprocess
from pathlib import Path

from versions import versions

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "package.json").read_text())
target = root / ".cache/node-contracts"
if target.exists():
    shutil.rmtree(target)
subprocess.run(["npm", "run", "generate"], cwd=root, check=True)
subprocess.run(
    [str(root / "node_modules/.bin/tsc"), "-p", "contracts/tsconfig.json"], cwd=root, check=True
)
for directory in ("proto", "third_party"):
    for source in (root / directory).rglob("*.proto"):
        destination = target / source.relative_to(root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
for name in ("LICENSE", "buf.lock"):
    shutil.copyfile(root / name, target / name)
package = {
    "name": "@agentos/contracts",
    "version": versions().semver,
    "type": "module",
    "license": "Apache-2.0",
    "exports": {"./*": {"types": "./*.d.ts", "default": "./*.js"}},
    "dependencies": {
        name: manifest["dependencies"][name]
        for name in ("@bufbuild/protobuf", "yaml", "canonicalize")
    },
}
(target / "package.json").write_text(json.dumps(package, indent=2) + "\n")
(root / "dist/contracts").mkdir(parents=True, exist_ok=True)
subprocess.run(
    ["npm", "pack", "--pack-destination", str(root / "dist/contracts"), "--silent"],
    cwd=target,
    check=True,
)
