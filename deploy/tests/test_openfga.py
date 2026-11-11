"""Validate the rendered OpenFGA deployment boundary."""

import base64
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class OpenFGADeploymentTest(unittest.TestCase):
    def test_platform_cluster_hosts_openfga_and_keeps_existing_storage(self):
        deploy = ROOT / "playbooks/deploy"
        tasks = yaml.safe_load((deploy / "database/cluster.yaml").read_text())
        cluster = next(task for task in tasks if task["name"] == "Converge PostgreSQL cluster")
        image = yaml.safe_load((deploy / "vars.yaml").read_text())["postgres_image"]
        default_storage = {"size": "2Gi", "storageClass": "local-path"}
        existing = {
            "bootstrap": {"recovery": {"source": "backup"}},
            "storage": {"size": "5Gi", "storageClass": "local-path", "resizeInUseVolumes": True},
        }
        for current in (None, existing):
            with self.subTest(current=current), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                playbook = [
                    {
                        "name": "Render platform PostgreSQL",
                        "hosts": "localhost",
                        "connection": "local",
                        "gather_facts": False,
                        "vars": {
                            **cluster["vars"],
                            "agentos_namespace": "agentos",
                            "postgres_image": image,
                            "kagent_postgres_resources": {},
                            "database_cluster": {
                                "resources": [{"spec": current}] if current else []
                            },
                            "definition": cluster["kubernetes.core.k8s"]["definition"],
                        },
                        "tasks": [
                            {
                                "name": "Render cluster",
                                "ansible.builtin.copy": {
                                    "content": "{{ definition | to_nice_yaml }}",
                                    "dest": str(output / "cluster.yaml"),
                                    "mode": "0600",
                                },
                            }
                        ],
                    }
                ]
                (output / "render.yaml").write_text(yaml.safe_dump(playbook))
                result = subprocess.run(
                    ["ansible-playbook", str(output / "render.yaml")],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                spec = yaml.safe_load((output / "cluster.yaml").read_text())["spec"]
                self.assertEqual(
                    spec["storage"], current["storage"] if current else default_storage
                )
                self.assertEqual(spec["imageName"], image)
                self.assertIn(
                    {
                        "name": "openfga_owner",
                        "login": True,
                        "passwordSecret": {"name": "openfga-postgres-app"},
                    },
                    spec["managed"]["roles"],
                )
        database = yaml.safe_load((deploy / "database/openfga.yaml").read_text())[0]
        self.assertEqual(
            database["kubernetes.core.k8s"]["definition"]["spec"],
            {"cluster": {"name": "kagent-postgres"}, "name": "openfga", "owner": "openfga_owner"},
        )

    def test_bootstrap_job_uses_pinned_cli_with_trusted_authentication(self):
        job = yaml.safe_load((ROOT / ".cache/check/openfga-bootstrap-job.yaml").read_text())
        pod = job["spec"]["template"]["spec"]
        cli = pod["containers"][0]
        self.assertEqual(job["kind"], "Job")
        self.assertEqual(job["metadata"]["namespace"], "agentos")
        self.assertIn("@sha256:", cli["image"])
        self.assertEqual(cli["args"][:2], ["store", "list"])
        self.assertIn("--api-token=$(API_TOKEN)", cli["args"])
        self.assertIn("--api-url=https://openfga.agentos.svc:8080", cli["args"])
        self.assertEqual(
            cli["env"][0]["valueFrom"]["secretKeyRef"],
            {"name": "openfga-auth", "key": "keys"},
        )
        self.assertIn({"name": "SSL_CERT_FILE", "value": "/etc/openfga/ca/tls.crt"}, cli["env"])
        self.assertIn(
            {
                "name": "ca",
                "secret": {
                    "secretName": "openfga-ca",
                    "items": [{"key": "tls.crt", "path": "tls.crt"}],
                },
            },
            pod["volumes"],
        )
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        self.assertEqual(job["spec"]["activeDeadlineSeconds"], 540)
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(cli["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(cli["securityContext"]["capabilities"]["drop"], ["ALL"])

    def test_packaged_model_bootstraps_exact_workspace_identities(self):
        version = yaml.safe_load((ROOT / "playbooks/deploy/vars.yaml").read_text())[
            "kagent_runtime_version"
        ]
        chart = ROOT / f".cache/check/runtime/kagent-{version}.tgz"
        with tarfile.open(chart, "r:gz") as archive:
            model = json.load(archive.extractfile("kagent/files/authorization-model.json"))
        workspace = next(item for item in model["type_definitions"] if item["type"] == "workspace")
        roles = {"member", "access_admin"}
        self.assertTrue(roles <= workspace["relations"].keys())

        def encode(value):
            return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")

        principal = encode("oidc:https://identity.example.test") + "." + encode("alice")
        user = "principal:" + encode(principal)
        tuples = json.loads((ROOT / ".cache/check/openfga-bootstrap-tuples.json").read_text())
        expected = {
            (user, role, f"workspace:{uid}")
            for uid in ("workspace-agentos", "workspace-team-a")
            for role in roles
        }
        self.assertEqual(
            {(item["user"], item["relation"], item["object"]) for item in tuples},
            expected,
        )
        self.assertEqual(len(tuples), len(expected))
        pending = json.loads(
            (ROOT / ".cache/check/openfga-bootstrap-pending-tuples.json").read_text()
        )
        self.assertEqual(
            {(item["user"], item["relation"], item["object"]) for item in pending},
            {(user, role, "workspace:workspace-team-a") for role in roles},
        )
        self.assertEqual(
            json.loads((ROOT / ".cache/check/openfga-bootstrap-complete-tuples.json").read_text()),
            [],
        )

    def test_chart_uses_isolated_postgres_authenticated_tls_and_pinned_images(self):
        values = yaml.safe_load((ROOT / ".cache/check/openfga-values.yaml").read_text())
        manifests = {
            item["kind"]: item
            for item in yaml.safe_load_all((ROOT / ".cache/check/native-openfga.yaml").read_text())
            if item
        }
        deployment = manifests["Deployment"]["spec"]["template"]["spec"]
        server = deployment["containers"][0]
        migration = deployment["initContainers"][0]

        self.assertEqual(values["replicaCount"], 1)
        self.assertEqual(values["datastore"]["engine"], "postgres")
        self.assertEqual(values["datastore"]["uriSecret"], "openfga-postgres")
        self.assertEqual(values["datastore"]["migrationType"], "initContainer")
        self.assertTrue(values["datastore"]["waitForMigrations"])
        self.assertNotIn("Job", manifests)
        self.assertEqual(
            values["authn"], {"method": "preshared", "preshared": {"keysSecret": "openfga-auth"}}
        )
        self.assertTrue(values["http"]["tls"]["enabled"])
        self.assertFalse(values["playground"]["enabled"])
        self.assertIn("@sha256:", server["image"])
        self.assertEqual(server["image"], migration["image"])
        self.assertEqual(migration["name"], "migrate-database")
        self.assertIn(
            {"name": "tls", "secret": {"secretName": "openfga-tls"}}, deployment["volumes"]
        )
        self.assertIn(
            {"name": "tls", "mountPath": "/etc/openfga/tls", "readOnly": True},
            server["volumeMounts"],
        )
        self.assertIn(
            {"name": "postgres-ca", "mountPath": "/etc/openfga/postgres", "readOnly": True},
            server["volumeMounts"],
        )
        self.assertIn(
            {"name": "postgres-ca", "mountPath": "/etc/openfga/postgres", "readOnly": True},
            migration["volumeMounts"],
        )
        ca_volume = {
            "name": "postgres-ca",
            "secret": {
                "secretName": "openfga-postgres-ca",
                "items": [{"key": "ca.crt", "path": "ca.crt"}],
            },
        }
        self.assertIn(ca_volume, deployment["volumes"])
        credentials = {env["name"]: env for env in server["env"]}
        self.assertEqual(
            credentials["OPENFGA_AUTHN_PRESHARED_KEYS"]["valueFrom"]["secretKeyRef"],
            {"name": "openfga-auth", "key": "keys"},
        )
        self.assertEqual(credentials["OPENFGA_HTTP_TLS_ENABLED"]["value"], "true")
