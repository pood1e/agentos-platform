"""Publish an immutable Helm package through the GitLab package API."""
import os
from pathlib import Path
import subprocess
import sys

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry
import yaml

version = yaml.safe_load(Path('charts/agentos/Chart.yaml').read_text())['version']
project_api = f'{os.environ["CI_API_V4_URL"]}/projects/{os.environ["CI_PROJECT_ID"]}'
registry = f'{project_api}/packages/helm'
with requests.Session() as session:
    session.auth = ('gitlab-ci-token', os.environ['CI_JOB_TOKEN'])
    session.mount('https://', HTTPAdapter(max_retries=Retry(
        total=3, backoff_factor=1, status_forcelist=[429, 502, 503, 504],
    )))
    package_url = f'{registry}/stable/charts/agentos-{version}.tgz'
    with session.get(package_url, stream=True, timeout=60) as existing:
        if existing.status_code == 200:
            print(f'agentos {version} is already published')
            sys.exit(0)
        if existing.status_code != 404:
            existing.raise_for_status()
    subprocess.run([sys.executable, 'ci/package-chart.py'], check=True)
    package = Path(f'dist/agentos-{version}.tgz')
    with package.open('rb') as chart:
        response = session.post(
            f'{registry}/api/stable/charts', files={'chart': (package.name, chart)}, timeout=60,
        )
        response.raise_for_status()
    print(f'Published agentos {version}')
