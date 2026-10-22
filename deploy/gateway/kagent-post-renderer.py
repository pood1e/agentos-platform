#!/usr/bin/env python3
"""Pin the controller and expose management through the platform console."""
import os
import sys

import yaml

resources = [
    resource for resource in yaml.safe_load_all(sys.stdin)
    if resource and not resource['metadata']['name'].startswith('kagent-ui') and not (
        resource.get('kind') == 'RemoteMCPServer'
        and resource['metadata']['name'] == 'kagent-api'
    )
]
for resource in resources:
    if resource.get('kind') == 'Deployment' and resource['metadata']['name'] == 'kagent-controller':
        for container in resource['spec']['template']['spec']['containers']:
            if container['name'] == 'controller':
                container['image'] = os.environ['AGENTOS_KAGENT_CONTROLLER_IMAGE']
yaml.safe_dump_all(resources, sys.stdout, sort_keys=False)
