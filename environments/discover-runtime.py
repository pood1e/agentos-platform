"""Read native identity discovery documents through the Kubernetes API."""
import argparse
import json

from kubernetes import client, config

parser = argparse.ArgumentParser()
parser.add_argument('--kubeconfig', required=True)
parser.add_argument('--namespace', required=True)
parser.add_argument('--release', required=True)
args = parser.parse_args()
config.load_kube_config(args.kubeconfig)
api = client.ApiClient()


def document(operation, **parameters):
    with operation(_preload_content=False, **parameters) as response:
        return json.load(response)


deployment = client.AppsV1Api(api).read_namespaced_deployment(f'{args.release}-console', args.namespace)
variables = {entry.name: entry.value for container in deployment.spec.template.spec.containers
             for entry in container.env or [] if entry.value is not None}
discovery = document(client.WellKnownApi(api).get_service_account_issuer_open_id_configuration)
result = {
    'platform_discovery_issuer': discovery['issuer'],
    'platform_discovery_jwks': document(client.OpenidApi(api).get_service_account_issuer_open_id_keyset),
    'platform_actor_issuer': variables['AGENTOS_ACTOR_ISSUER'],
    'platform_actor_audiences': json.loads(variables['AGENTOS_ACTOR_AUDIENCES']),
    'platform_actor_jwks': document(
        client.CoreV1Api(api).connect_get_namespaced_service_proxy_with_path,
        name='https:idp:443', namespace='ate-system', path='openid/v1/jwks',
    ),
}
print(json.dumps(result))
