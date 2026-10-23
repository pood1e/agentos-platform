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


def get(path):
    return api.call_api(path, 'GET', response_type='object', auth_settings=['BearerToken'],
                        _return_http_data_only=True)


deployment = client.AppsV1Api(api).read_namespaced_deployment(f'{args.release}-console', args.namespace)
variables = {entry.name: entry.value for container in deployment.spec.template.spec.containers
             for entry in container.env or [] if entry.value is not None}
discovery = get('/.well-known/openid-configuration')
result = {
    'platform_discovery_issuer': discovery['issuer'],
    'platform_discovery_jwks': get('/openid/v1/jwks'),
    'platform_actor_issuer': variables['AGENTOS_ACTOR_ISSUER'],
    'platform_actor_audiences': json.loads(variables['AGENTOS_ACTOR_AUDIENCES']),
    'platform_actor_jwks': get('/api/v1/namespaces/ate-system/services/https:idp:443/proxy/openid/v1/jwks'),
}
print(json.dumps(result))
