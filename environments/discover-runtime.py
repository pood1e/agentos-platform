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


result = {
    'platform_actor_issuer': document(client.CoreV1Api(api).connect_get_namespaced_service_proxy_with_path,
                                      name='https:idp:443', namespace='ate-system',
                                      path='.well-known/openid-configuration')['issuer'],
}
print(json.dumps(result))
