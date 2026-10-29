"""Verify the published contract boundary and imports from the actual npm/wheel archives."""

import email
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ContractsTest(unittest.TestCase):
    def test_node_archive_contains_only_contracts_and_imports_in_isolation(self):
        archive = next((ROOT / "dist/contracts").glob("*.tgz"))
        with tarfile.open(archive) as package:
            files = {entry.name.removeprefix("package/") for entry in package if entry.isfile()}
            for name in files:
                path = Path(name)
                self.assertTrue(
                    name in {"package.json", "LICENSE", "buf.lock", "authorization.json"}
                    or (path.parts[0] in {"proto", "third_party"} and name.endswith(".proto"))
                    or (path.parts[:2] == ("gen", "schema") and name.endswith(".json"))
                    or (
                        path.parts[0] == "gen"
                        and name.endswith(
                            ("_pb.js", "_pb.d.ts", "/kubernetes.js", "/kubernetes.d.ts")
                        )
                    ),
                    name,
                )
            manifest = json.load(package.extractfile("package/package.json"))
            self.assertEqual(set(manifest["dependencies"]), {"@bufbuild/protobuf"})
            self.assertEqual(
                json.load(package.extractfile("package/authorization.json")),
                json.loads((ROOT / "gen/authorization.json").read_text()),
            )
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(
                [
                    "npm",
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--prefer-offline",
                    str(archive),
                ],
                cwd=directory,
                check=True,
            )
            Path(directory, "consumer.ts").write_text("""
import type {AccessPlanStatus} from '@agentos/contracts/gen/kubernetes';
const status: AccessPlanStatus = {observedGeneration: 1, targets: [
  {server: 'tools', service: 'tools', catalog: false, tools: [{name: 'read', write: false, requireApproval: false}]}]};
export default status;
""")
            subprocess.run(
                [
                    str(ROOT / "node_modules/.bin/tsc"),
                    "--noEmit",
                    "--strict",
                    "--skipLibCheck",
                    "--module",
                    "NodeNext",
                    "--target",
                    "ES2023",
                    "consumer.ts",
                ],
                cwd=directory,
                check=True,
            )
            subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "--eval",
                    """
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {create} from '@bufbuild/protobuf';
import {RoleDefinitionSchema} from '@agentos/contracts/gen/agentos/console/v1/role_pb';
import status from '@agentos/contracts/gen/schema/agentos.accessplan.json' with {type:'json'};
import roles from '@agentos/contracts/authorization.json' with {type:'json'};
assert.equal(create(RoleDefinitionSchema, {name:'reader'}).name, 'reader');
assert.ok(status.properties.status.properties.observedGeneration);
assert.ok(status.properties.status.properties.targets);
assert.ok(Object.keys(roles).length);
const proto = import.meta.resolve('@agentos/contracts/proto/agentos/console/v1/role.proto');
assert.match(readFileSync(new URL(proto), 'utf8'), /message RoleDefinition/);
const native = import.meta.resolve('@agentos/contracts/third_party/kagent/kagent/api/v1/collaboration.proto');
assert.match(readFileSync(new URL(native), 'utf8'), /package kagent.api.v1/);
await assert.rejects(import('@agentos/contracts/shared/access-plans'),
  {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
""",
                ],
                cwd=directory,
                check=True,
            )

    def test_python_archive_contains_only_generated_bindings_and_role_metadata(self):
        archive = next((ROOT / "dist/contracts").glob("*.whl"))
        with zipfile.ZipFile(archive) as package:
            for name in package.namelist():
                if name.endswith("/"):
                    continue
                self.assertTrue(
                    name.endswith("_pb2.py")
                    or name == "agentos/authorization.json"
                    or any(part.endswith(".dist-info") for part in Path(name).parts),
                    name,
                )
            metadata = email.message_from_bytes(
                package.read(
                    next(name for name in package.namelist() if name.endswith("/METADATA"))
                )
            )
            self.assertEqual(metadata.get_all("Requires-Dist"), ["protobuf==7.36.2"])
            self.assertEqual(
                json.loads(package.read("agentos/authorization.json")),
                json.loads((ROOT / "gen/authorization.json").read_text()),
            )
            with tempfile.TemporaryDirectory() as directory:
                package.extractall(directory)
                subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-c",
                        """
import sys
sys.path.insert(0, sys.argv[1])
from agentos.voice.v1 import voice_pb2
from kagent.api.v1 import collaboration_pb2
assert voice_pb2.DESCRIPTOR.package == 'agentos.voice.v1'
assert collaboration_pb2.DESCRIPTOR.package == 'kagent.api.v1'
""",
                        directory,
                    ],
                    cwd=directory,
                    check=True,
                )


if __name__ == "__main__":
    unittest.main()
