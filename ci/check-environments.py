"""Render the environment kit for the example solution and validate the manifests and bindings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import yaml

out = Path('.cache/environment-check')
shutil.rmtree(out, ignore_errors=True)
subprocess.run(
    [str(Path(sys.executable).with_name('ansible-playbook')), 'ci/render-environments.yaml',
     '-i', 'tests/fixtures/environments/inventory.yaml', '-e', '@tests/fixtures/environments/vars.yaml'],
    check=True, env={**os.environ, 'ANSIBLE_CONFIG': 'deploy/ansible.cfg'},
)
manifests = sorted(str(path) for path in out.glob('*.yaml') if not path.name.endswith(('-initialize-tools.yaml', '-prune-tools.yaml')))
subprocess.run(['.cache/bin/kubeconform', '-strict', '-summary', '-kubernetes-version', '1.37.1', '-schema-location', 'default',
                '-schema-location', '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', *manifests], check=True)


def load(name):
    return [doc for doc in yaml.safe_load_all((out / name).read_text()) if doc]


config = yaml.safe_load(Path('tests/fixtures/solution-chart/values.yaml').read_text())['global']['agentos']
toolsets = config['toolsets']
for environment in config['environments']:
    name, approval = environment['name'], environment['governance'] == 'approval'
    identities = [item for item in config['identities'] if name in item.get('environments', [name])]
    gateway = load(f'{name}-gateway.yaml')
    listener = next(doc for doc in gateway if doc['kind'] == 'Gateway')['spec']['listeners'][0]
    assert listener['protocol'] == 'HTTPS' and listener['tls']['certificateRefs']
    authentication = next(doc for doc in gateway if doc['kind'] == 'AgentgatewayPolicy' and doc['metadata']['name'] == 'gateway-auth')['spec']['traffic']
    assert 'apiKeyAuthentication' not in authentication
    assert authentication['jwtAuthentication']['mode'] == 'Strict'
    assert authentication['jwtAuthentication']['mcp']['resourceMetadata']['resource'].startswith('https://')
    gateway_auth = next(doc for doc in gateway if doc['kind'] == 'AgentgatewayPolicy' and doc['metadata']['name'] == 'gateway-auth')
    assert gateway_auth['spec']['frontend']['http']['maxBufferSize'] == '16Mi'
    backends = {doc['metadata']['name']: doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'AgentgatewayBackend'}
    expected = {f'{project}-{item["name"]}' for item in identities for project in toolsets if project in item['services']}
    assert set(backends) == expected, f'{name}: backends follow identities'
    for identity in identities:
        for project, access in identity['services'].items():
            tiers = ['readOnly'] + (['write'] if access != 'read' else []) + (['managementReadOnly', 'management'] if access == 'manage' else [])
            allowed = sorted(tool for tier in tiers for tool in toolsets[project].get(tier, []))
            expression = backends[f'{project}-{identity["name"]}']['spec']['policies']['mcp']['authorization']['policy']['matchExpressions'][0]
            assert sorted(json.loads(expression.removeprefix('mcp.tool.name in '))) == allowed
            if project == 'kubernetes':
                exchange = backends[f'{project}-{identity["name"]}']['spec']['mcp']['targets'][0]['static']['policies']['auth']['oauthTokenExchange']
                assert exchange['audiences'] == [f'{name}-kubernetes']
                assert exchange['subjectToken']['source']['header']['name'] == 'Authorization'
    for route in (doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'HTTPRoute'):
        assert route['spec']['parentRefs'][0]['sectionName'] == 'https'
        match = route['spec']['rules'][0]['matches'][0]
        assert 'headers' not in match and match['path']['type'] == 'Exact'
        identity = next(item for item in identities if f"/mcp/{item['name']}/" in match['path']['value'])
        policy = next(doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'AgentgatewayPolicy' and doc['metadata']['name'] == route['metadata']['name'] + '-identity')
        assert policy['spec']['traffic']['authorization']['policy']['matchExpressions'] == [f"has(jwt.azp) && jwt.azp == 'agentos-{identity['name']}'"]
        assert route['spec']['rules'][0]['filters'][0]['requestHeaderModifier']['remove'] == (['x-substrate-actor-token'] if route['metadata']['name'].startswith('kubernetes-') else ['x-substrate-actor-token', 'authorization'])
    for backend in (doc for doc in load(f'{name}-platform-services.yaml') if doc['kind'] == 'AgentgatewayBackend'):
        transport = backend['spec']['policies']['extAuth']
        assert transport['failureMode'] == 'FailClosed'
        assert transport['backendRef']['port'] == 9090
        assert transport['http']['allowedResponseHeaders'] == ['authorization']
        tls = backend['spec']['policies']['tls']
        assert tls['caCertificateRefs'] and tls['verifySubjectAltNames'] and not tls.get('insecureSkipVerify')
        processor = backend['spec']['policies']['mcp']['guardrails']['processors'][0]['remote']
        assert processor['failureMode'] == 'FailClosed'
        assert processor['metadata']['identity'] == "'catalog'"
    bindings = yaml.safe_load((out / f'{name}-initialize-tools.yaml').read_text())
    for item in bindings:
        binding = item['mcp']
        if binding['server']['name'] == 'team-sessions':
            continue
        project = next(project for project in toolsets if binding['server']['name'].startswith(f'{name}-{project}-'))
        reviewed = toolsets[project].get('approval', toolsets[project].get('write', []))
        assert all(binding['requireApproval'] == (approval and tool.removeprefix(f'{name}-{project}_') in reviewed) for tool in binding['tools']), f'{name}: approval bindings'
    pruned = yaml.safe_load((out / f'{name}-prune-tools.yaml').read_text())
    assert [item['mcp']['server']['name'] for item in pruned] == ['team-sessions'], f'{name}: retired bindings remain'
    remotes = [doc for doc in load(f'{name}-platform-gateway.yaml') if doc['kind'] == 'RemoteMCPServer']
    assert all('headersFrom' not in doc['spec'] and doc['metadata']['annotations']['agentos.dev/discovery-auth'] == 'kubernetes' for doc in remotes)
    assert all('agentos-mcp-gateway.' in doc['spec']['url'] for doc in remotes)
    for doc in load(f'{name}-platform-gateway.yaml'):
        if doc['kind'] == 'HTTPRoute':
            assert doc['metadata']['labels']['agentos.dev/mcp-source'] == doc['metadata']['ownerReferences'][0]['uid']
        if doc['kind'] == 'AgentgatewayPolicy' and doc['metadata']['name'].endswith('-runtime-auth'):
            assert 'targetRefs' not in doc['spec']
            selector = doc['spec']['targetSelectors'][0]
            assert selector['kind'] == 'HTTPRoute'
            assert selector['matchLabels']['agentos.dev/mcp-source'] == doc['metadata']['ownerReferences'][0]['uid']
    text = (out / f'{name}-platform-gateway.yaml').read_text()
    assert all(legacy not in text for legacy in ['x-agentos-engineer', 'x-agentos-execution-kind', 'x-agentos-subject-token', 'apiKey.'])

connections = json.loads(load('platform-governance.yaml')[0]['stringData']['connections.json'])['environments']
assert [(item['environment']['name'], item['environment']['governance']) for item in connections] == [
    ('env-approval', 'GOVERNANCE_APPROVAL'), ('env-direct', 'GOVERNANCE_DIRECT')]
assert all(item['issuer'].startswith('https://') and item['resource'].startswith('https://') and 'authorization' not in item for item in connections)
print('Environment validation passed')
