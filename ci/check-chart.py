"""Validate the platform chart, an example solution chart and the deployment post-renderers."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
from urllib.parse import urlparse

import jinja2
import yaml

subprocess.run([sys.executable, 'ci/test-package-chart.py'], check=True)

os.umask(0o077)
cache = Path('.cache/chart-check')
cache.mkdir(parents=True, exist_ok=True)
helm = str(Path('.cache/bin/helm').resolve())
versions = yaml.safe_load(Path('deploy/vars.yaml').read_text())
chart = 'charts/agentos'
solution = 'tests/fixtures/solution-chart'
values = 'tests/fixtures/chart-values.yaml'
registry = 'registry.example.com/agentos'
site = {'agentos_namespace': 'agentos', 'agentos_image_registry': registry, 'app_release_name': 'agentos'}


def run(*args):
    return subprocess.check_output(args, text=True)


def pinned(name):
    return versions[name].replace('{{ agentos_image_registry }}', registry)


def render(path):
    context = {**versions, **site, 'substrate_microvm_image': pinned('substrate_microvm_image'),
               'harness_defaults': yaml.safe_load(Path(chart, 'values.yaml').read_text())['harnesses'],
               'microvm_image_credentials': {'auth': {'registry.example.com': {}, 'harness.example.com': {}}}}
    templates = jinja2.Environment(undefined=jinja2.StrictUndefined)
    templates.filters['to_json'] = json.dumps
    return templates.from_string(Path(path).read_text()).render(context)


subprocess.run([helm, 'dependency', 'build', solution, '--skip-refresh'], check=True)
subprocess.run([helm, 'lint', chart, '-f', values, '--strict'], check=True)
subprocess.run([helm, 'lint', solution, '--strict'], check=True)
subprocess.run([sys.executable, 'ci/check-speech.py', chart, values], check=True)
kagent = run(helm, 'template', 'schemas', 'oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds', '--version', versions['kagent_version'])
url = 'https://raw.githubusercontent.com/traefik/traefik/v3.7.13/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml'
with urllib.request.urlopen(url, timeout=60) as response:
    traefik = response.read().decode()
agentgateway = run(helm, 'template', 'schemas', 'oci://cr.agentgateway.dev/charts/agentgateway-crds', '--version', versions['agentgateway_version'])
with urllib.request.urlopen(f"https://github.com/kubernetes-sigs/gateway-api/releases/download/{versions['gateway_api_version']}/standard-install.yaml", timeout=60) as response:
    gateway = response.read().decode()
for doc in yaml.safe_load_all('\n---\n'.join([kagent, traefik, agentgateway, gateway])):
    if not doc or doc.get('kind') != 'CustomResourceDefinition':
        continue
    spec = doc['spec']
    for version in spec['versions']:
        schema = version['schema']['openAPIV3Schema']
        schema['additionalProperties'] = False
        name = f"{spec['group']}/{spec['names']['kind'].lower()}_{version['name']}.json"
        path = cache / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(schema))

solution_values = yaml.safe_load(Path(solution, 'values.yaml').read_text())['global']['agentos']
system_presets = {path.stem for path in Path(chart, 'presets/system').glob('*.yaml')}
solution_presets = {path.stem for path in Path(solution, 'presets/engineers').glob('*.yaml')}
direct_only = json.dumps([{'name': 'env-direct', 'governance': 'direct'}])


def check_bindings(templates, config):
    toolsets, environments = config['toolsets'], config['environments']
    for template in templates:
        engineer = template['metadata']['name']
        profile = next((item for item in config['identities'] if item['name'] == engineer), None)
        expected = {}
        if profile:
            for env in environments:
                if env['name'] not in profile.get('environments', [item['name'] for item in environments]):
                    continue
                for project, access in profile['services'].items():
                    tools = toolsets[project]
                    server = f"{env['name']}-{project}-{engineer}"
                    read = tools.get('readOnly', []) + (tools.get('managementReadOnly', []) if access == 'manage' else [])
                    write = tools.get('write', []) + (tools.get('management', []) if access == 'manage' else [])
                    for tool in read:
                        expected[(server, f"{env['name']}-{project}_{tool}")] = False
                    if access in ('operate', 'manage'):
                        reviewed = tools.get('approval', tools.get('write', []))
                        for tool in write:
                            expected[(server + '-changes', f"{env['name']}-{project}_{tool}")] = env['governance'] == 'approval' and tool in reviewed
        actual = {}
        for binding in template['spec']['tools']:
            mcp = binding['mcp']
            server = mcp['server']['name']
            if server in ('team-sessions', 'kagent-collaboration'):
                continue
            for tool in mcp['tools']:
                key = (server, tool)
                assert key not in actual, f'{engineer}: duplicate tool binding'
                actual[key] = mcp['requireApproval']
        assert actual == expected, f'{engineer}: environment scope or native review policy differs'


for name, source, overrides, presets, config in [
    ('platform', chart, ['-f', values], system_presets, None),
    ('alternate', chart, ['-f', values, '--namespace', 'operations'], system_presets, None),
    ('evaluation', chart, ['-f', values, '-f', 'tests/fixtures/evaluation-values.yaml'], system_presets, None),
    ('solution', solution, ['--namespace', 'agentos'], system_presets | solution_presets, solution_values),
    ('direct-only', solution, ['--namespace', 'agentos', '--set-json', f'global.agentos.environments={direct_only}'], system_presets | solution_presets,
     {**solution_values, 'environments': json.loads(direct_only)}),
]:
    manifest = run(helm, 'template', 'agentos', source, *overrides)
    path = cache / f'{name}.yaml'
    path.write_text(manifest)
    docs = [doc for doc in yaml.safe_load_all(manifest) if doc]
    identities = [(doc['apiVersion'], doc['kind'], doc['metadata'].get('namespace', ''), doc['metadata']['name']) for doc in docs]
    assert len(identities) == len(set(identities)), f'{name}: duplicate resources'
    for policy in [doc for doc in docs if doc['kind'] == 'AgentgatewayPolicy' and 'traffic' in doc['spec']]:
        targets = policy['spec'].get('targetRefs', []) + policy['spec'].get('targetSelectors', [])
        assert all(target['kind'] in {'Gateway', 'HTTPRoute', 'GRPCRoute', 'ListenerSet', 'InferencePool'} for target in targets), f'{name}: traffic policy targets an unsupported resource'
    gateway_secret = next(doc for doc in docs if doc['kind'] == 'Secret' and doc['metadata']['name'] == 'agentos-gateway')
    token = base64.b64decode(gateway_secret['data']['api-key'])
    keys = next(doc for doc in docs if doc['kind'] == 'ConfigMap' and doc['metadata']['name'] == 'agentos-gateway-keys')
    expected_hash = 'sha256:' + hashlib.sha256(token).hexdigest()
    assert any(json.loads(value)['keyHash'] == expected_hash for value in keys['data'].values()), 'Gateway key hash does not match the client credential'
    remotes = [doc for doc in docs if doc['kind'] == 'RemoteMCPServer']
    assert all('agentos-mcp-gateway.' in item['spec']['url'] for item in remotes)
    assert all(item['spec']['headersFrom'][0]['valueFrom']['name'] == 'agentos-gateway' for item in remotes)
    assert all(item['spec']['timeout'] == '10m' for item in remotes)
    for backend in [doc for doc in docs if doc['kind'] == 'AgentgatewayBackend' and 'mcp' in doc['spec']]:
        assert all(target['static']['policies']['http']['requestTimeout'] == '10m' for target in backend['spec']['mcp']['targets'])
    model_hosts = {urlparse(doc['spec']['openAI']['baseUrl']).hostname for doc in docs if doc['kind'] == 'ModelConfig'}
    mcp_hosts = {urlparse(doc['spec']['url']).hostname for doc in remotes}
    assert model_hosts.isdisjoint(mcp_hosts), 'Substrate credentials require separate model and MCP authorities'
    templates = [doc for doc in docs if doc['kind'] == 'AgentTemplate']
    assert {item['metadata']['name'] for item in templates} == presets
    assistant = next(item for item in templates if item['metadata']['name'] == 'assistant')
    platform_bindings = [binding['mcp'] for binding in assistant['spec']['tools'] if binding['mcp']['server']['name'] == 'team-sessions']
    assert len(platform_bindings) == 1 and set(platform_bindings[0]['tools']) == {'list_agents', 'create_session', 'search_knowledge'}, 'Chat assistant must discover and select native Agents'
    assert all('agentos.dev/display-name' not in doc['metadata'].get('annotations', {}) for doc in templates)
    api = next(doc for doc in docs if doc['kind'] == 'Deployment' and doc['metadata']['name'].endswith('-console'))
    assert api['spec']['strategy'] == {'type': 'RollingUpdate', 'rollingUpdate': {'maxSurge': 1, 'maxUnavailable': 0}}
    assert api['spec']['minReadySeconds'] == 5
    assert api['spec']['template']['spec']['terminationGracePeriodSeconds'] == 60
    container = api['spec']['template']['spec']['containers'][0]
    assert container['lifecycle']['preStop'] == {'sleep': {'seconds': 5}}
    assert container['command'] == ['node', 'build/server/platform/main.js']
    env = {item['name']: item for item in container['env']}
    mode = 'oidc' if source == chart else 'none'
    assert env['AGENTOS_AUTH_MODE']['value'] == mode
    proxy = [item for item in api['spec']['template']['spec']['containers'] if item['name'] == 'identity']
    assert bool(proxy) == (mode == 'oidc')
    if proxy:
        assert '--skip-jwt-bearer-tokens=true' in proxy[0]['args']
        assert f"--oidc-extra-audience={env['AGENTOS_OIDC_AUDIENCE']['value']}" in proxy[0]['args']
    if mode == 'none':
        assert 'AGENTOS_OIDC_ISSUER' not in env
    assert env['AGENTOS_GATEWAY_URL']['value'].startswith('http://agentos-gateway.')
    assert env['AGENTOS_GATEWAY_TOKEN']['valueFrom']['secretKeyRef']['key'] == 'api-key'
    assert env['AGENTOS_MCP_TOKEN']['valueFrom']['secretKeyRef']['key'] == 'token'
    assert 'AGENTOS_AUTH_CONFIG' not in env
    assert not any(doc['kind'] == 'Middleware' for doc in docs)
    assert not any('oauth2-proxy' in doc['metadata']['name'] for doc in docs)
    console_ingress = next(doc for doc in docs if doc['kind'] == 'Ingress' and doc['metadata']['name'].endswith('-console'))
    public_port = console_ingress['spec']['rules'][0]['http']['paths'][0]['backend']['service']['port']['name']
    assert public_port == ('identity' if mode == 'oidc' else 'http')
    assert 'traefik.ingress.kubernetes.io/router.middlewares' not in console_ingress['metadata'].get('annotations', {})
    assert not any(doc['kind'] == 'Deployment' and doc['metadata']['name'].endswith('-team-sessions') for doc in docs)
    workspace = next(doc for doc in docs if doc['kind'] == 'AgentgatewayBackend' and doc['metadata']['name'] == 'team-sessions')
    target = workspace['spec']['mcp']['targets'][0]['static']
    assert target['host'] == api['metadata']['name'] and target['port'] == 8080
    policy = next(doc for doc in docs if doc['kind'] == 'NetworkPolicy' and doc['metadata']['name'].endswith('-gateway'))
    assert any(peer.get('podSelector', {}).get('matchLabels', {}).get('app.kubernetes.io/component') == 'console' for rule in policy['spec']['ingress'] for peer in rule['from'])
    assert not any(doc['kind'] == 'Namespace' for doc in docs), 'Agent chart owns a target namespace'
    if config:
        check_bindings(templates, config)
        catalog = json.loads(next(doc for doc in docs if doc['kind'] == 'ConfigMap' and doc['metadata']['name'] == 'agentos-skills')['data']['catalog.json'])['items']
        skill_url = f"http://agentos-skill-gateway.agentos.svc.cluster.local:8080{config['skillRepository']['path']}"
        assert [item['skill']['git']['url'] for item in catalog] == [skill_url] * len(config['skills'])
        inspection = next(item for item in templates if item['metadata']['name'] == 'inspection')
        assert inspection['spec']['skills'] == [{'name': item['skill']['name'], 'source': {key: value for key, value in item['skill'].items() if key != 'name'}} for item in catalog]
        route = next(doc for doc in docs if doc['kind'] == 'HTTPRoute' and doc['metadata']['name'] == 'agentos-skill-repository')
        matches = route['spec']['rules'][0]['matches']
        assert [(item['method'], item['path']['value'].split('/')[-1]) for item in matches] == [('GET', 'refs'), ('POST', 'git-upload-pack')]
        assert matches[0]['queryParams'] == [{'type': 'Exact', 'name': 'service', 'value': 'git-upload-pack'}]
    else:
        assert not any(doc['kind'] == 'HTTPRoute' and doc['metadata']['name'].endswith('-skill-repository') for doc in docs)
    subprocess.run(['.cache/bin/kubeconform', '-strict', '-summary', '-kubernetes-version', '1.37.1', '-schema-location', 'default', '-schema-location', str(cache) + '/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', str(path)], check=True)

for invalid in [['--set', 'image.digest=latest'], ['--set', 'pack.image=latest'], ['--set', 'managedEnvironments={env}'], ['--set', 'gateway.skillRepository.host=git.example.test'], ['--set', 'evaluation.enabled=true'], ['--set', 'evaluation.unrecognized=true'], ['--set', 'authorization.jwksUrl=https://id.example.test'], ['--set', 'oauth2-proxy.extraArgs.provider=oidc']]:
    result = subprocess.run([helm, 'template', 'invalid', chart, '-f', values, *invalid], capture_output=True)
    assert result.returncode != 0, f'Invalid values were accepted: {invalid}'

original = [
    {'apiVersion': 'api.kagent.dev/v1alpha3', 'kind': 'RemoteMCPServer', 'metadata': {'name': 'external-environment'}, 'spec': {'url': 'http://external-environment:8084/mcp', 'protocol': 'STREAMABLE_HTTP'}},
    {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'other'}, 'spec': {'ports': [{'port': 8080}]}},
    {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'kagent-controller'}, 'spec': {'template': {'spec': {'containers': [{'name': 'controller', 'image': 'upstream'}, {'name': 'sidecar', 'image': 'sidecar'}]}}}},
    {'apiVersion': 'api.kagent.dev/v1alpha3', 'kind': 'RemoteMCPServer', 'metadata': {'name': 'kagent-api'}, 'spec': {'url': 'http://kagent-controller:8083/mcp', 'protocol': 'STREAMABLE_HTTP'}},
    {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'kagent-ui'}},
    {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'kagent-ui'}},
    {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'kagent-ui-config'}},
]
rendered = subprocess.check_output([sys.executable, 'deploy/gateway/kagent-post-renderer.py'], input=yaml.safe_dump_all(original) + '\n---\n', text=True,
                                   env={**os.environ, 'AGENTOS_KAGENT_CONTROLLER_IMAGE': pinned('kagent_controller_image')})
patched = list(yaml.safe_load_all(rendered))
assert len(patched) == 3, 'Duplicate direct kagent API registration was retained'
assert patched[0] == original[0], 'Post-renderer modified an external environment connection'
assert patched[1] == original[1], 'Post-renderer modified an unrelated resource'
assert patched[2]['spec']['template']['spec']['containers'] == [{'name': 'controller', 'image': pinned('kagent_controller_image')}, {'name': 'sidecar', 'image': 'sidecar'}]
substrate_deployment = {
    'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'ate-api-server'},
    'spec': {'template': {'spec': {'containers': [{'name': 'ate-api-server', 'image': 'upstream'}]}}},
}
bucket_job = {
    'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 'rustfs-bucket-init'},
    'spec': {'template': {'spec': {'restartPolicy': 'OnFailure', 'containers': [{'name': 'init', 'image': 'upstream'}]}}},
}
atelet = {
    'apiVersion': 'apps/v1', 'kind': 'DaemonSet', 'metadata': {'name': 'atelet'},
    'spec': {'template': {'spec': {'containers': [{'name': 'atelet', 'image': 'upstream'}]}}},
}
substrate_values = yaml.safe_load(render('deploy/values/substrate.yaml.j2'))
assert not substrate_values.get('imagePullSecrets'), 'Global pull secrets change immutable initialization Jobs'
rendered = subprocess.check_output(
    [sys.executable, 'deploy/microvm/substrate-post-renderer.py'],
    input=yaml.safe_dump_all([substrate_deployment, original[1], bucket_job, atelet]), text=True,
    env={**os.environ, 'AGENTOS_SUBSTRATE_API_IMAGE': pinned('substrate_api_image')},
)
patched = list(yaml.safe_load_all(rendered))
assert patched[0]['spec']['template']['spec']['containers'][0]['image'] == pinned('substrate_api_image')
assert patched[0]['spec']['template']['spec']['imagePullSecrets'] == [{'name': 'agentos-registry'}]
assert patched[1] == original[1]
assert patched[2] == bucket_job, 'Post-renderer changed an immutable initialization Job'
atelet_pod = patched[3]['spec']['template']['spec']
assert atelet_pod['volumes'] == [{'name': 'image-credentials', 'secret': {'secretName': 'atelet-image-credentials', 'defaultMode': 0o400}}]
assert atelet_pod['containers'][0]['volumeMounts'] == [{'name': 'image-credentials', 'mountPath': '/run/image-credentials', 'readOnly': True}]
provider = yaml.safe_load(substrate_values['atelet']['imageCredentialProviderConfigYAML'])['providers'][0]
assert provider['matchImages'] == ['registry.example.com', 'harness.example.com']
assert provider['args'] == ['cat', '/run/image-credentials/response.json']
assert provider['defaultCacheDuration'] == '0s'
kagent_values = yaml.safe_load(render('deploy/values/kagent.yaml.j2'))
assert kagent_values['substrateWorkerPool']['workerImage'] == pinned('substrate_microvm_image')
assert kagent_values['global']['watchNamespaces'] == ['agentos']
assert kagent_values['config']['runtimeDefaults']['controlPlaneUrl'] == 'http://agentos-console.agentos.svc:9091'
assert kagent_values['controller']['substrateClientCertificate']['enabled']
native_values = cache / 'kagent-values.yaml'
native_values.write_text(yaml.safe_dump(kagent_values))
native = yaml.safe_load_all(run(
    helm, 'template', 'kagent', 'oci://ghcr.io/kagent-dev/kagent/helm/kagent',
    '--version', versions['kagent_version'], '-f', str(native_values),
))
pool = next(item for item in native if item and item['kind'] == 'WorkerPool')
assert pool['spec']['template']['serviceAccountName'] == 'kagent-workers'
assert pool['spec']['replicas'] == 3
print('Chart validation passed')
