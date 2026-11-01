"""Prepare kubeconform schemas from the pinned upstream CRD distributions."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import requests
import yaml

cache = Path(".cache/chart-check")
cache.mkdir(parents=True, exist_ok=True)
KAGENT = "852629af657f9e337c05e56d2a0650c292e5086f"
AGENTGATEWAY = "v1.7.0"
GATEWAY_API = "v1.6.1"
CERT_MANAGER = "v1.21.2"


def download(name, version, url, checksum, accept="application/vnd.github.raw+json"):
    path = cache / f"{name}-{version}.yaml"
    if not path.exists():
        headers = {"Accept": accept}
        if token := os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = f"Bearer {token}"
        response = requests.get(url, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.content
        if hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError(f"{name} checksum differs from the pinned upstream artifact")
        path.write_bytes(data)
    if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        raise ValueError(f"{name} cached checksum differs from the pinned upstream artifact")
    return path.read_text()


def chart(name, reference, version):
    path = cache / f"{name}-{version}.yaml"
    if not path.exists():
        path.write_text(
            subprocess.check_output(
                [
                    "helm",
                    "template",
                    "schemas",
                    reference,
                    "--version",
                    version,
                ],
                text=True,
            )
        )
    return path.read_text()


sources = [
    *[path.read_text() for path in Path("controller/config/crd/bases").glob("*.yaml")],
    chart(
        "kagent-crds",
        "oci://ghcr.io/pood1e/kagent/helm/kagent-crds",
        f"0.0.0-main.g{KAGENT}",
    ),
    chart(
        "agentgateway-crds",
        "oci://ghcr.io/agentgateway/charts/agentgateway-crds",
        AGENTGATEWAY,
    ),
    download(
        "traefik-crds",
        "3.7.13",
        "https://api.github.com/repos/traefik/traefik/contents/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml?ref=v3.7.13",
        "1d5e8558803804562238b0d4a57174aadd6d87c36e3c4c55199ebcc356a9406c",
    ),
    download(
        "gateway-crds",
        GATEWAY_API,
        "https://api.github.com/repos/kubernetes-sigs/gateway-api/releases/assets/479238882",
        "24d931f22abd8e40c973264319ead7cfa09d0fb7716b7ab1ee2ff174cb063a73",
        "application/octet-stream",
    ),
    download(
        "cert-manager-crds",
        CERT_MANAGER,
        "https://api.github.com/repos/cert-manager/cert-manager/releases/assets/556636674",
        "262fef78478492cd35b73a1b227106b7802f9c056361d1f561d04b32d751337f",
        "application/octet-stream",
    ),
]
for resource in yaml.safe_load_all("\n---\n".join(sources)):
    if not resource or resource.get("kind") != "CustomResourceDefinition":
        continue
    spec = resource["spec"]
    if resource["metadata"]["name"] == "agentgatewaypolicies.agentgateway.dev":
        provider = spec["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"][
            "properties"
        ]["traffic"]["properties"]["jwtAuthentication"]["properties"]["providers"]["items"]
        if provider != json.loads(Path("third_party/agentgateway/jwt-provider.json").read_text()):
            raise ValueError("JWT provider schema differs from the pinned agentgateway CRD")
    for version in spec["versions"]:
        schema = version["schema"]["openAPIV3Schema"]
        schema["additionalProperties"] = False
        path = cache / spec["group"] / f"{spec['names']['kind'].lower()}_{version['name']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(schema))
