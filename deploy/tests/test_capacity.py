"""Render native PostgreSQL and worker capacity through the production Ansible values."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "playbooks/deploy"


class CapacityTest(unittest.TestCase):
    def test_default_and_site_capacity_are_rendered(self):
        defaults = yaml.safe_load((DEPLOY / "vars.yaml").read_text())
        tasks = yaml.safe_load((DEPLOY / "database/cluster.yaml").read_text())
        cluster = next(t for t in tasks if t["name"] == "Converge PostgreSQL cluster")
        resources = cluster["kubernetes.core.k8s"]["definition"]["spec"]["resources"]
        expanded = {
            "requests": {"cpu": "250m", "memory": "1Gi"},
            "limits": {"cpu": "2", "memory": "4Gi"},
        }
        workers = {
            "requests": {"cpu": "500m", "memory": "8Gi"},
            "limits": {"cpu": "8", "memory": "8Gi"},
        }
        for overrides, expected_resources, expected_pool, expected_workers in (
            ({}, defaults["kagent_postgres_resources"], 16, defaults["substrate_worker_resources"]),
            (
                {
                    "kagent_postgres_resources": expanded,
                    "kagent_postgres_pool_max_conns": 8,
                    "substrate_worker_resources": workers,
                },
                expanded,
                8,
                workers,
            ),
        ):
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                variables = {
                    "ansible_python_interpreter": "{{ ansible_playbook_python }}",
                    "harness_defaults": yaml.safe_load(
                        (ROOT / "tests/fixtures/harnesses.yaml").read_text()
                    ),
                    "app_values": {
                        "identity": {
                            "issuer": "https://id.example",
                            "audience": "agentos",
                            "clientId": "agentos",
                        },
                        "route": {"api": {"origin": "https://api.example", "parentRefs": []}},
                    },
                    "oidc_discovery": {"json": {"token_endpoint": "https://id.example/token"}},
                    "capacity": resources,
                }
                playbook = output / "render.yaml"
                playbook.write_text(
                    yaml.safe_dump(
                        [
                            {
                                "name": "Render native database capacity",
                                "hosts": "localhost",
                                "connection": "local",
                                "gather_facts": False,
                                "vars_files": [str(DEPLOY / "vars.yaml")],
                                "vars": variables,
                                "tasks": [
                                    {
                                        "name": "Render native runtime values",
                                        "ansible.builtin.template": {
                                            "src": str(DEPLOY / "values/kagent.yaml.j2"),
                                            "dest": str(output / "values.yaml"),
                                            "mode": "0600",
                                        },
                                    },
                                    {
                                        "name": "Render database resources",
                                        "ansible.builtin.copy": {
                                            "content": "{{ capacity | to_json }}",
                                            "dest": str(output / "resources.json"),
                                            "mode": "0600",
                                        },
                                    },
                                ],
                            }
                        ]
                    )
                )
                result = subprocess.run(
                    ["ansible-playbook", str(playbook), "--extra-vars", json.dumps(overrides)],
                    cwd=ROOT,
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                values = yaml.safe_load((output / "values.yaml").read_text())
                self.assertEqual(values["config"]["database"]["pool"]["maxConns"], expected_pool)
                self.assertEqual(
                    values["substrateWorkerPool"]["template"]["resources"], expected_workers
                )
                self.assertEqual(
                    json.loads((output / "resources.json").read_text()), expected_resources
                )
