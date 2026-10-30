"""Prepare kubeconform schemas from the pinned upstream CRD distributions."""

import json
import subprocess
import urllib.request
from pathlib import Path

import yaml

cache = Path(".cache/chart-check")
cache.mkdir(parents=True, exist_ok=True)
KAGENT = "da1590dfc985941a0e73aaeec08ff3b88bd997ce"
AGENTGATEWAY = "v1.7.0"
GATEWAY_API = "v1.6.1"
CERT_MANAGER = "v1.21.2"


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


native = cache / f"kagent-crds-{KAGENT}.yaml"
if not native.exists():
    native.write_text(
        "\n---\n".join(
            download(
                f"kagent-{kind}",
                KAGENT,
                f"https://raw.githubusercontent.com/pood1e/kagent/{KAGENT}/helm/kagent-crds/templates/api.kagent.dev_{kind}.yaml",
            )
            for kind in (
                "agents",
                "agenttemplates",
                "egresspolicies",
                "harnesses",
                "modelconfigs",
                "modelproviderconfigs",
                "remotemcpservers",
                "sandboxtemplates",
            )
        )
    )

sources = [
    *[path.read_text() for path in Path("controller/config/crd/bases").glob("*.yaml")],
    native.read_text(),
    chart(
        "agentgateway-crds",
        "oci://cr.agentgateway.dev/charts/agentgateway-crds",
        AGENTGATEWAY,
    ),
    download(
        "traefik-crds",
        "3.7.13",
        "https://raw.githubusercontent.com/traefik/traefik/v3.7.13/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml",
    ),
    download(
        "gateway-crds",
        GATEWAY_API,
        f"https://github.com/kubernetes-sigs/gateway-api/releases/download/{GATEWAY_API}/standard-install.yaml",
    ),
    download(
        "cert-manager-crds",
        CERT_MANAGER,
        f"https://github.com/cert-manager/cert-manager/releases/download/{CERT_MANAGER}/cert-manager.crds.yaml",
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
