"""Read native identity discovery documents through the Kubernetes API."""
import argparse
import json

from kubernetes import client, config

parser = argparse.ArgumentParser()
parser.add_argument('--kubeconfig', required=True)
args = parser.parse_args()
config.load_kube_config(args.kubeconfig)
api = client.ApiClient()


def document(operation, **parameters):
    with operation(_preload_content=False, **parameters) as response:
        return json.load(response)


discovery = document(client.WellKnownApi(api).get_service_account_issuer_open_id_configuration)
result = {
    'platform_discovery_issuer': discovery['issuer'],
    'platform_discovery_jwks': document(client.OpenidApi(api).get_service_account_issuer_open_id_keyset),
    'platform_actor_issuer': document(client.CoreV1Api(api).connect_get_namespaced_service_proxy_with_path,
                                      name='https:idp:443', namespace='ate-system',
                                      path='.well-known/openid-configuration')['issuer'],
    'platform_actor_jwks': document(
        client.CoreV1Api(api).connect_get_namespaced_service_proxy_with_path,
        name='https:idp:443', namespace='ate-system', path='openid/v1/jwks',
    ),
}
print(json.dumps(result))
