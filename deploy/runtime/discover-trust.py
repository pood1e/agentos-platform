"""Read native workload issuers and signing keys through authenticated Kubernetes discovery."""

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


print(json.dumps({
    'kubernetesIssuer': document(client.WellKnownApi(api).get_service_account_issuer_open_id_configuration)['issuer'],
    'kubernetesJWKS': document(client.OpenidApi(api).get_service_account_issuer_open_id_keyset),
    'actorJWKS': document(client.CoreV1Api(api).connect_get_namespaced_service_proxy_with_path,
                          name='https:idp:443', namespace='ate-system', path='openid/v1/jwks'),
}))
