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
    assert set(keys) == {item['name'] for item in identities} | ({'change-control'} if approval else set()), f'{name}: gateway keys'
    assert (out / f'{name}-change-control.yaml').exists() == approval, f'{name}: change control follows governance'
    backends = {doc['metadata']['name']: doc for doc in load(f'{name}-backends.yaml') if doc['kind'] == 'AgentgatewayBackend'}
    expected = {f'{project}-{item["name"]}' for item in identities for project in toolsets if project in item['services']}
    assert set(backends) == expected, f'{name}: backends follow identities'
    for identity in identities:
        for project, access in identity['services'].items():
            tiers = ['readOnly'] + (['write'] if access != 'read' else []) + (['managementReadOnly', 'management'] if access == 'manage' else [])
            allowed = sorted(tool for tier in tiers for tool in toolsets[project].get(tier, []))
            expression = backends[f'{project}-{identity["name"]}']['spec']['policies']['mcp']['authorization']['policy']['matchExpressions'][0]
            assert sorted(json.loads(expression.removeprefix('mcp.tool.name in '))) == allowed, f'{name}: {project} tools for {identity["name"]}'
    bindings = yaml.safe_load((out / f'{name}-initialize-tools.yaml').read_text())
    assert all(item['mcp']['requireApproval'] == (approval and item['mcp']['server']['name'].endswith('-changes')) for item in bindings), f'{name}: approval bindings'
    pruned = yaml.safe_load((out / f'{name}-prune-tools.yaml').read_text())
    assert [item['mcp']['server']['name'] for item in pruned] == ['team-sessions'], f'{name}: retired bindings remain'
    routes = [doc for doc in load(f'{name}-platform-gateway.yaml') if doc['kind'] == 'HTTPRoute' and 'headers' in doc['spec']['rules'][0]['matches'][0]]
    assert all(route['spec']['rules'][0]['matches'][0]['headers'][0]['name'] == 'x-agentos-engineer' for route in routes)

control = load('env-approval-change-control.yaml')
policy = next(doc for doc in control if doc['kind'] == 'AgentgatewayPolicy')
assert policy['spec']['targetSelectors'][0]['matchLabels'] == {'agentos.dev/component': 'environment-tool'}
assert policy['spec']['backend']['mcp']['guardrails']['processors'][0]['remote']['failureMode'] == 'FailClosed'
secret = next(doc for doc in control if doc['kind'] == 'Secret')['stringData']
assert json.loads(secret['environment.json']) == {'name': 'env-approval', 'governance': 'GOVERNANCE_APPROVAL', 'approvalUrl': 'https://tickets.example.test'}
assert yaml.safe_load(secret['toolsets.yaml']) == toolsets
connections = json.loads(load('platform-operations.yaml')[0]['stringData']['connections.json'])['environments']
assert [(item['environment']['name'], item['environment']['governance'], item.get('controlUrl')) for item in connections] == [
    ('env-approval', 'GOVERNANCE_APPROVAL', 'http://192.0.2.21:31000'), ('env-direct', 'GOVERNANCE_DIRECT', None)]
assert connections[0]['authorization'] == 'Bearer key-change-control' and connections[0]['environment']['links']
print('Environment validation passed')
