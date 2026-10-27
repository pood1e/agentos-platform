"""Prepare kubeconform schemas from the pinned upstream CRD distributions."""

import json
import subprocess
import urllib.request
from pathlib import Path

import yaml

cache = Path(".cache/chart-check")
cache.mkdir(parents=True, exist_ok=True)
versions = yaml.safe_load(Path("deploy/vars.yaml").read_text())


def download(name, version, url):
    path = cache / f"{name}-{version}.yaml"
    if not path.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            path.write_bytes(response.read())
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
        "oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds",
        versions["kagent_version"],
    ),
    chart(
        "agentgateway-crds",
        "oci://cr.agentgateway.dev/charts/agentgateway-crds",
        versions["agentgateway_version"],
    ),
    download(
        "traefik-crds",
        "3.7.13",
        "https://raw.githubusercontent.com/traefik/traefik/v3.7.13/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml",
    ),
    download(
        "gateway-crds",
        versions["gateway_api_version"],
        f"https://github.com/kubernetes-sigs/gateway-api/releases/download/{versions['gateway_api_version']}/standard-install.yaml",
    ),
    download(
        "cert-manager-crds",
        versions["cert_manager_version"],
        f"https://github.com/cert-manager/cert-manager/releases/download/{versions['cert_manager_version']}/cert-manager.crds.yaml",
    ),
]
for resource in yaml.safe_load_all("\n---\n".join(sources)):
    if not resource or resource.get("kind") != "CustomResourceDefinition":
        continue
    spec = resource["spec"]
    for version in spec["versions"]:
        schema = version["schema"]["openAPIV3Schema"]
        schema["additionalProperties"] = False
        path = cache / spec["group"] / f"{spec['names']['kind'].lower()}_{version['name']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(schema))
