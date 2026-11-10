"""Validate native post-renderer boundaries and cold-start routing guarantees."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

DEPLOY = Path(__file__).resolve().parents[1] / "playbooks/deploy"
VERSIONS = yaml.safe_load((DEPLOY / "vars.yaml").read_text())


def resource(kind, name, spec):
    api_version = {
        "Deployment": "apps/v1",
        "DaemonSet": "apps/v1",
        "Job": "batch/v1",
        "RemoteMCPServer": "api.kagent.dev/v1alpha3",
    }.get(kind, "v1")
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def transform(overlay, resources, image=None):
    with tempfile.TemporaryDirectory() as directory:
        chart = Path(directory)
        (chart / "Chart.yaml").write_text(
            "apiVersion: v2\nname: native-postrenderer\nversion: 0.1.0\n"
        )
        (chart / "templates").mkdir()
        (chart / "templates/resources.yaml").write_text(yaml.safe_dump_all(resources))
        result = subprocess.run(
            ["helm", "template", "test", str(chart), "--post-renderer", "agentos-kustomize"],
            text=True,
            capture_output=True,
            check=True,
            env={
                **os.environ,
                "HELM_PLUGINS": str(DEPLOY / "helm-plugins"),
                "AGENTOS_KUSTOMIZE_OVERLAY": str(DEPLOY / "kustomize" / overlay),
                **({"AGENTOS_PATCHED_IMAGE": image} if image else {}),
            },
        )
    return {item["metadata"]["name"]: item for item in yaml.safe_load_all(result.stdout)}


class PostRendererTest(unittest.TestCase):
    def test_kagent_keeps_external_resources_and_sidecars(self):
        external = resource(
            "RemoteMCPServer",
            "external-environment",
            {
                "url": "http://external-environment:8084/mcp",
                "protocol": "STREAMABLE_HTTP",
            },
        )
        service = resource("Service", "other", {"ports": [{"port": 8080}]})
        controller = resource(
            "Deployment",
            "kagent-controller",
            {
                "template": {
                    "spec": {
                        "containers": [
                            {"name": "controller", "image": "upstream"},
                            {"name": "sidecar", "image": "sidecar"},
                        ],
                    }
                }
            },
        )
        originals = [
            external,
            service,
            controller,
            resource("RemoteMCPServer", "kagent-api", {}),
            resource("Deployment", "kagent-ui", {}),
            resource("Service", "kagent-ui", {}),
            resource("ConfigMap", "kagent-ui-config", {}),
        ]
        result = transform(
            "kagent",
            originals,
            VERSIONS["kagent_controller_image"],
        )
        self.assertEqual(len(result), 3)
        self.assertEqual(result["external-environment"], external)
        self.assertEqual(result["other"], service)
        self.assertEqual(
            result["kagent-controller"]["spec"]["template"]["spec"]["containers"],
            [
                {"name": "controller", "image": VERSIONS["kagent_controller_image"]},
                {"name": "sidecar", "image": "sidecar"},
            ],
        )

    def test_substrate_changes_workloads_and_keeps_immutable_initialization_jobs(self):
        deployment = resource(
            "Deployment",
            "ate-api-server",
            {
                "template": {
                    "spec": {
                        "containers": [{"name": "ate-api-server", "image": "upstream"}],
                    }
                }
            },
        )
        service = resource("Service", "other", {"ports": [{"port": 8080}]})
        job = resource(
            "Job",
            "rustfs-bucket-init",
            {
                "template": {
                    "spec": {
                        "restartPolicy": "OnFailure",
                        "containers": [{"name": "init", "image": "upstream"}],
                    }
                }
            },
        )
        job["metadata"]["annotations"] = {"helm.sh/hook": "pre-install,pre-upgrade"}
        router = resource("ConfigMap", "atenet-router-agentgateway-config", {})
        router.pop("spec")
        policies = {"substrateIngress": {"host": "api:443"}}
        router["data"] = {
            "config.yaml": yaml.safe_dump(
                {
                    "routes": [
                        {
                            "name": "substrate-actors",
                            "policies": policies,
                        }
                    ],
                    "binds": [
                        {
                            "listeners": [
                                {
                                    "routes": [
                                        {
                                            "name": "substrate-actors-tunneled",
                                            "policies": policies,
                                        }
                                    ]
                                }
                            ]
                        }
                    ],
                },
                sort_keys=False,
            )
        }
        result = transform("substrate", [deployment, service, job, router])
        self.assertEqual(result["other"], service)
        self.assertEqual(result["rustfs-bucket-init"], job)
        self.assertEqual(result["ate-api-server"], deployment)
        configuration = yaml.safe_load(
            result["atenet-router-agentgateway-config"]["data"]["config.yaml"]
        )
        for route in [
            configuration["routes"][0],
            configuration["binds"][0]["listeners"][0]["routes"][0],
        ]:
            self.assertEqual(
                route["policies"]["substrateIngress"],
                {
                    "host": "api:443",
                    "requestParking": {"budget": "2m"},
                },
            )

    def test_atelet_mounts_the_projected_image_credentials(self):
        atelet = resource(
            "DaemonSet",
            "atelet",
            {
                "template": {
                    "spec": {
                        "containers": [{"name": "atelet", "image": "upstream"}],
                    }
                }
            },
        )
        service = resource("Service", "other", {"ports": [{"port": 8080}]})
        result = transform("atelet", [atelet, service])
        self.assertEqual(result["other"], service)
        worker = result["atelet"]["spec"]["template"]["spec"]
        self.assertEqual(
            worker["volumes"],
            [
                {
                    "name": "image-credentials",
                    "secret": {
                        "secretName": "atelet-image-credentials",
                        "defaultMode": 0o400,
                    },
                }
            ],
        )
        self.assertEqual(
            worker["containers"][0]["volumeMounts"],
            [
                {
                    "name": "image-credentials",
                    "mountPath": "/run/image-credentials",
                    "readOnly": True,
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
