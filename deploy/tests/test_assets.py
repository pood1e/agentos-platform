"""Verify the asset uploader's access through Substrate's default-deny ingress."""

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1] / "playbooks/deploy/microvm"


class AssetUploadAccessTest(unittest.TestCase):
    def test_uploader_has_scoped_object_store_access(self):
        source = (ROOT / "assets-job.yaml.j2").read_text()
        job = yaml.safe_load(
            re.sub(r"microvm-assets-\{\{[^\n]+\}\}", "microvm-assets-test", source)
        )
        labels = job["spec"]["template"]["metadata"]["labels"]
        policy = yaml.safe_load((ROOT / "assets-networkpolicy.yaml").read_text())
        self.assertEqual(policy["metadata"]["namespace"], job["metadata"]["namespace"])
        self.assertEqual(policy["spec"]["podSelector"], {"matchLabels": {"app": "rustfs"}})
        self.assertEqual(policy["spec"]["policyTypes"], ["Ingress"])
        self.assertEqual(
            policy["spec"]["ingress"],
            [
                {
                    "from": [{"podSelector": {"matchLabels": labels}}],
                    "ports": [{"port": 9000, "protocol": "TCP"}],
                }
            ],
        )
        tasks = yaml.safe_load((ROOT / "tasks.yaml").read_text())
        names = [task["name"] for task in tasks]
        self.assertLess(
            names.index("Allow verified microVM asset uploads"),
            names.index("Stage verified microVM assets in object storage"),
        )
