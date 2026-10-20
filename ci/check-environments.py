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
    keys = next(doc for doc in load(f'{name}-gateway.yaml') if doc['kind'] == 'ConfigMap')['data']
    assert set(keys) == {item['name'] for item in identities}, f'{name}: gateway keys'
    backends = {doc['metadata']['name']: doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'AgentgatewayBackend'}
    expected = {f'{project}-{item["name"]}' for item in identities for project in toolsets if project in item['services']}
    expected |= {f'kubernetes-{item["name"]}-user' for item in identities if item['name'] != 'catalog' and 'kubernetes' in item['services']}
    assert set(backends) == expected, f'{name}: backends follow identities'
    for identity in identities:
        for project, access in identity['services'].items():
            tiers = ['readOnly'] + (['write'] if access != 'read' else []) + (['managementReadOnly', 'management'] if access == 'manage' else [])
            allowed = sorted(tool for tier in tiers for tool in toolsets[project].get(tier, []))
            expression = backends[f'{project}-{identity["name"]}']['spec']['policies']['mcp']['authorization']['policy']['matchExpressions'][0]
            assert sorted(json.loads(expression.removeprefix('mcp.tool.name in '))) == allowed, f'{name}: {project} tools for {identity["name"]}'
            if project == 'kubernetes' and identity['name'] != 'catalog':
                delegated = backends[f'{project}-{identity["name"]}-user']['spec']
                assert delegated['mcp']['sessionRouting'] == 'Stateless'
                assert backends[f'{project}-{identity["name"]}']['spec']['mcp']['sessionRouting'] == 'Stateless'
                assert delegated['policies']['mcp']['authorization']['policy']['matchExpressions'][0] == expression
                exchange = delegated['mcp']['targets'][0]['static']['policies']['auth']['oauthTokenExchange']
                assert exchange['audiences'] == [f'{name}-kubernetes']
                assert exchange['subjectToken']['source']['header']['name'] == 'x-agentos-subject-token'
    user_routes = [doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'HTTPRoute' and doc['metadata']['name'].endswith('-user')]
    assert user_routes and all(route['spec']['rules'][0]['matches'][0]['headers'][1]['value'] == 'user' for route in user_routes)
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
    routes = [doc for doc in load(f'{name}-platform-gateway.yaml') if doc['kind'] == 'HTTPRoute' and 'headers' in doc['spec']['rules'][0]['matches'][0]]
    assert all(route['spec']['rules'][0]['matches'][0]['headers'][0]['name'] == 'x-agentos-engineer' for route in routes)
    for route in routes:
        headers = route['spec']['rules'][0]['filters'][0]['requestHeaderModifier']
        assert headers['set'] == [{'name': 'x-agentos-execution-kind', 'value': 'service'}]
        assert headers['remove'] == ['x-agentos-subject-token']

connections = json.loads(load('platform-governance.yaml')[0]['stringData']['connections.json'])['environments']
assert [(item['environment']['name'], item['environment']['governance']) for item in connections] == [
    ('env-approval', 'GOVERNANCE_APPROVAL'), ('env-direct', 'GOVERNANCE_DIRECT')]
assert all('approvalUrl' not in item and 'authorization' not in item for item in connections)
assert connections[0]['environment']['links']
print('Environment validation passed')
