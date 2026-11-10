"""Validate native workspace watches rendered from application targets."""

import os
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class WorkspaceDeploymentTest(unittest.TestCase):
    def test_native_controller_watches_configured_application_workspaces(self):
        base = ROOT / ".cache/check"
        default = yaml.safe_load((base / "kagent-values.yaml").read_text())
        multiple = yaml.safe_load((base / "multi-workspace/kagent-values.yaml").read_text())
        self.assertEqual(default["global"]["watchNamespaces"], ["agentos"])
        self.assertEqual(multiple["global"]["watchNamespaces"], ["agentos", "team-a"])
        version = yaml.safe_load((ROOT / "playbooks/deploy/vars.yaml").read_text())[
            "kagent_runtime_version"
        ]
        result = subprocess.run(
            [
                "helm",
                "template",
                "kagent",
                str(base / f"runtime/kagent-{version}.tgz"),
                "--namespace",
                "agentos",
                "-f",
                str(base / "multi-workspace/kagent-values.yaml"),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "HELM_PLUGINS": str(ROOT / "playbooks/deploy/helm-plugins")},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        bindings = {
            (item["metadata"].get("namespace"), item["metadata"]["name"])
            for item in yaml.safe_load_all(result.stdout)
            if item and item["kind"] == "RoleBinding"
        }
        for namespace in ("agentos", "team-a"):
            self.assertIn((namespace, "kagent-reconciliation-rolebinding"), bindings)
            self.assertIn((namespace, "kagent-management-rolebinding"), bindings)
