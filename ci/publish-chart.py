"""Publish a versioned platform chart to the native OCI registry."""
import json
import os
from pathlib import Path
import subprocess
import sys

subprocess.run([sys.executable, 'ci/package-chart.py'], check=True)
release = json.loads(Path('dist/release.json').read_text())
helm = '.cache/bin/helm'
subprocess.run([helm, 'registry', 'login', os.environ['CI_REGISTRY'], '--username', os.environ['CI_REGISTRY_USER'], '--password-stdin'], input=os.environ['CI_REGISTRY_PASSWORD'], text=True, check=True, capture_output=True)
subprocess.run([helm, 'push', f"dist/agentos-{release['version']}.tgz", f"oci://{os.environ['CI_REGISTRY_IMAGE']}/charts"], check=True)
print('Published platform chart', release['version'])
