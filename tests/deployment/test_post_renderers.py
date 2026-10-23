"""Validate native post-renderer boundaries and cold-start routing guarantees."""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
VERSIONS = yaml.safe_load((ROOT / "deploy/vars.yaml").read_text())


def image(name):
    return VERSIONS[name].replace("{{ agentos_image_registry }}", "registry.example.com/agentos")


def resource(kind, name, spec):
    api_version = {
        "Deployment": "apps/v1",
        "DaemonSet": "apps/v1",
        "Job": "batch/v1",
        "RemoteMCPServer": "api.kagent.dev/v1alpha3",
    }.get(kind, "v1")
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def transform(path, resources, variables):
    result = subprocess.run(
        [sys.executable, str(ROOT / path)],
        input=yaml.safe_dump_all(resources),
        text=True,
        capture_output=True,
        check=True,
        env={**os.environ, **variables},
    )
    return list(yaml.safe_load_all(result.stdout))


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
            "deploy/gateway/kagent-post-renderer.py",
            originals,
            {
                "AGENTOS_KAGENT_CONTROLLER_IMAGE": image("kagent_controller_image"),
            },
        )
        self.assertEqual(len(result), 3)
        self.assertEqual(result[:2], originals[:2])
        self.assertEqual(
            result[2]["spec"]["template"]["spec"]["containers"],
            [
                {"name": "controller", "image": image("kagent_controller_image")},
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
        router = resource("ConfigMap", "atenet-router-agentgateway-config", {})
        router.pop("spec")
        router["data"] = {
            "config.yaml": yaml.safe_dump(
                {
                    "routes": [{"policies": {"substrateIngress": {"host": "api:443"}}}],
                    "binds": [
                        {
                            "listeners": [
                                {
                                    "routes": [
                                        {"policies": {"substrateIngress": {"host": "api:443"}}}
                                    ]
                                }
                            ]
                        }
                    ],
                }
            )
        }
        result = transform(
            "deploy/microvm/substrate-post-renderer.py",
            [deployment, service, job, atelet, router],
            {
                "AGENTOS_SUBSTRATE_API_IMAGE": image("substrate_api_image"),
            },
        )
        self.assertEqual(result[1], service)
        self.assertEqual(result[2], job)
        pod = result[0]["spec"]["template"]["spec"]
        self.assertEqual(pod["containers"][0]["image"], image("substrate_api_image"))
        self.assertEqual(pod["imagePullSecrets"], [{"name": "agentos-registry"}])
        worker = result[3]["spec"]["template"]["spec"]
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
        configuration = yaml.safe_load(result[4]["data"]["config.yaml"])
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


if __name__ == "__main__":
    unittest.main()
