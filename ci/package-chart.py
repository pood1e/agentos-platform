"""Package the chart with the images built by this pipeline, referenced from the build registry."""
import json
import os
from pathlib import Path
import subprocess

import yaml

PLACEHOLDER = 'registry.example.com/agentos'
chart = Path('charts/agentos')
registry = os.environ['CI_REGISTRY_IMAGE']
package = json.loads(Path('package.json').read_text())
metadata = json.loads(Path('.cache/build-metadata.json').read_text())
digest = metadata['containerimage.digest']
assert digest.startswith('sha256:') and len(digest) == 71
info = yaml.safe_load((chart / 'Chart.yaml').read_text())
assert info['appVersion'] == package['version']
if os.environ.get('CI_COMMIT_BRANCH') and os.environ.get('CI_COMMIT_BRANCH') != os.environ.get('CI_DEFAULT_BRANCH'):
    info['version'] = f"{info['version']}-{os.environ['CI_COMMIT_SHA'][:12]}"
    (chart / 'Chart.yaml').write_text(yaml.safe_dump(info, sort_keys=False))
values = yaml.safe_load((chart / 'values.yaml').read_text())
versions = yaml.safe_load(Path('deploy/vars.yaml').read_text())
harnesses = values['harnesses']
assert harnesses['memory']['workload']['image'] == harnesses['standard']['workload']['image']
pins = {
    'controller': versions['kagent_controller_image'],
    'substrate-api': versions['substrate_api_image'],
    'substrate-microvm': versions['substrate_microvm_image'],
    'claude-harness': harnesses['claude']['workload']['image'],
    'standard-harness': harnesses['standard']['workload']['image'],
    'codex-harness': harnesses['codex']['workload']['image'],
}
for name, image in pins.items():
    image_metadata = Path(f'.cache/{name}-build-metadata.json')
    if image_metadata.exists():
        built_digest = json.loads(image_metadata.read_text())['containerimage.digest']
        assert image.endswith('@' + built_digest), f'Published {name} image differs from the deployment pin'


def published(image):
    for prefix in (PLACEHOLDER + '/', '{{ agentos_image_registry }}/'):
        if image.startswith(prefix):
            return registry + '/' + image.removeprefix(prefix)
    raise AssertionError(f'{image} is not a platform image')


values['image'] = {'repository': registry, 'digest': digest}
for harness in harnesses.values():
    harness['workload']['image'] = published(harness['workload']['image'])
(chart / 'values.yaml').write_text(yaml.safe_dump(values, sort_keys=False))
subprocess.run(['.cache/bin/helm', 'package', str(chart), '--destination', 'dist'], check=True)
release = {'version': info['version'], 'image': f'{registry}@{digest}'}
release.update({name: published(image) for name, image in pins.items()})
Path('dist/release.json').write_text(json.dumps(release, indent=2) + '\n')
print('Release image:', digest)
