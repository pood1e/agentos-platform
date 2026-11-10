"""Render gateway trust through the production Ansible template."""

import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "playbooks/deploy/templates/runtime-trust.yaml.j2"


class RuntimeTrustTest(unittest.TestCase):
    def test_bundles_preserve_pem_boundaries_and_exact_certificate_bytes(self):
        first = "-----BEGIN CERTIFICATE-----\nAbCd\n-----END CERTIFICATE-----"
        second = first.replace("AbCd", "abcd")
        cases = [[first], [second, first, first], [first, second], [first + "\n", second]]
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            playbook = destination / "render.yaml"
            playbook.write_text(
                yaml.safe_dump(
                    [
                        {
                            "name": "Render native runtime trust",
                            "hosts": "localhost",
                            "connection": "local",
                            "gather_facts": False,
                            "vars": {
                                "ansible_python_interpreter": "{{ ansible_playbook_python }}",
                                "agentos_namespace": "platform",
                            },
                            "tasks": [
                                {
                                    "name": "Render gateway trust",
                                    "ansible.builtin.template": {
                                        "src": str(TEMPLATE),
                                        "dest": str(destination / "bundle-{{ item.index }}.yaml"),
                                        "mode": "0600",
                                    },
                                    "vars": {
                                        "service_dns_trust": {"resources": "{{ item.resources }}"}
                                    },
                                    "loop": [
                                        {
                                            "index": index,
                                            "resources": [
                                                {"spec": {"trustBundle": ca}} for ca in certificates
                                            ],
                                        }
                                        for index, certificates in enumerate(cases)
                                    ],
                                }
                            ],
                        }
                    ]
                )
            )
            result = subprocess.run(
                ["ansible-playbook", str(playbook)], cwd=ROOT, text=True, capture_output=True
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for index, case in enumerate(cases):
                with self.subTest(case=index):
                    manifest = yaml.safe_load((destination / f"bundle-{index}.yaml").read_text())
                    self.assertEqual(manifest["kind"], "ConfigMap")
                    self.assertEqual(
                        manifest["metadata"],
                        {"name": "substrate-service-dns-ca", "namespace": "platform"},
                    )
                    self.assertEqual(manifest["data"], {"ca.crt": "\n".join(sorted(set(case)))})
