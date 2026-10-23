#!/usr/bin/env python3
"""Pin Substrate images and mount native image pull credentials."""
import os
import sys

import yaml

resources = [resource for resource in yaml.safe_load_all(sys.stdin) if resource]
for resource in resources:
    if resource.get('kind') == 'ConfigMap' and resource['metadata']['name'] == 'atenet-router-agentgateway-config':
        config = yaml.safe_load(resource['data']['config.yaml'])
        routes = [config.get('routes', [])]
        routes.extend(listener.get('routes', []) for bind in config.get('binds', []) for listener in bind.get('listeners', []))
        for group in routes:
            for route in group:
                ingress = route.get('policies', {}).get('substrateIngress')
                if ingress is not None:
                    ingress['requestParking'] = {'budget': '2m'}
        resource['data']['config.yaml'] = yaml.safe_dump(config, sort_keys=False)
    if resource.get('kind') == 'DaemonSet' and resource['metadata']['name'] == 'atelet':
        pod = resource['spec']['template']['spec']
        pod.setdefault('volumes', []).append({
            'name': 'image-credentials',
            'secret': {'secretName': 'atelet-image-credentials', 'defaultMode': 0o400},
        })
        for container in pod['containers']:
            if container['name'] == 'atelet':
                container.setdefault('volumeMounts', []).append({
                    'name': 'image-credentials', 'mountPath': '/run/image-credentials', 'readOnly': True,
                })
    if resource.get('kind') == 'Deployment' and resource['metadata']['name'] == 'ate-api-server':
        pod = resource['spec']['template']['spec']
        for container in pod['containers']:
            if container['name'] == 'ate-api-server':
                container['image'] = os.environ['AGENTOS_SUBSTRATE_API_IMAGE']
        pull_secrets = pod.setdefault('imagePullSecrets', [])
        if not any(secret['name'] == 'agentos-registry' for secret in pull_secrets):
            pull_secrets.append({'name': 'agentos-registry'})
yaml.safe_dump_all(resources, sys.stdout, sort_keys=False)
