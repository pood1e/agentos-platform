"""Prepare kubeconform schemas from the pinned upstream CRD distributions."""

import json
import subprocess
from pathlib import Path

import yaml

cache = Path(".cache/chart-check")
cache.mkdir(parents=True, exist_ok=True)
KAGENT = "2d5c4a62c06df47cc7ae48f11905838f51264a49"
AGENTGATEWAY = "v1.7.0"
GATEWAY_API = "v1.6.1"
CERT_MANAGER = "v1.21.2"


def module_crds(name, module, version, pattern):
    path = cache / f"{name}-{version}.yaml"
    if not path.exists():
        metadata = json.loads(
            subprocess.check_output(
                ["go", "mod", "download", "-json", f"{module}@{version}"], text=True
            )
        )
        files = sorted(Path(metadata["Dir"]).glob(pattern))
        if not files:
            raise ValueError(f"{name} CRDs are absent from the pinned module")
        documents = [
            resource
            for resource in yaml.safe_load_all("\n---\n".join(file.read_text() for file in files))
            if resource and resource.get("kind") == "CustomResourceDefinition"
        ]
        path.write_text(yaml.safe_dump_all(documents, sort_keys=False))
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
        f"0.0.0-dev.g{KAGENT}",
    ),
    chart(
        "agentgateway-crds",
        "oci://ghcr.io/agentgateway/charts/agentgateway-crds",
        AGENTGATEWAY,
    ),
    module_crds(
        "traefik-crds",
        "github.com/traefik/traefik/v3",
        "v3.7.13",
        "docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml",
    ),
    module_crds(
        "gateway-crds", "sigs.k8s.io/gateway-api", GATEWAY_API, "config/crd/standard/*.yaml"
    ),
    module_crds(
        "cert-manager-crds",
        "github.com/cert-manager/cert-manager",
        CERT_MANAGER,
        "deploy/crds/*.yaml",
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
