"""Reconcile native Substrate policies through the official CLI."""
import json
import subprocess
import sys

namespace, release, mode, *additional_spaces = sys.argv[1:]
controller = f'user:spiffe://cluster.local/ns/{namespace}/sa/kagent-controller'
dataplane = f'user:system:serviceaccount:{namespace}:{release}-dataplane'


def invoke(*args, document=None):
    result = subprocess.run(
        ['/usr/local/bin/kubectl-ate', *args, '-o', 'json'],
        input=json.dumps(document) if document is not None else None,
        text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else None


changed = False


def reconcile(scope, bindings):
    global changed
    current = invoke('get', 'access-policy', *scope)
    if (current or {}).get('bindings', []) == bindings:
        return
    changed = True
    if mode == 'apply':
        invoke(
            'update' if current else 'create', 'access-policy', *scope, '-f', '-',
            document={'metadata': current['metadata'] if current else {'name': 'default'},
                      'bindings': bindings},
        )


reconcile(['--global'], [{'role': 'viewer', 'members': [controller]}])
spaces = {item['metadata']['name'] for item in invoke('get', 'atespaces').get('atespaces', [])}
for atespace in [namespace, *additional_spaces]:
    if atespace not in spaces:
        changed = True
        if mode == 'check':
            continue
        invoke('create', 'atespace', atespace)
    reconcile(['-a', atespace], [
        {'role': 'editor', 'members': [controller]},
        {'role': 'viewer', 'members': [dataplane]},
    ])
print(json.dumps({'changed': changed}))
