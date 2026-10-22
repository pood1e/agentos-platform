"""Exercise release packaging with optional runtime build artifacts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = 'registry.internal.test/agentos/platform'


def relative(image):
    for prefix in ('registry.example.com/agentos/', '{{ agentos_image_registry }}/'):
        if image.startswith(prefix):
            return image.removeprefix(prefix)
    raise AssertionError(image)


class PackageChartTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='agentos-release-')
        self.addCleanup(self.directory.cleanup)
        self.workspace = Path(self.directory.name)
        for name in ['package.json', 'charts/agentos/Chart.yaml', 'charts/agentos/values.yaml', 'deploy/vars.yaml']:
            target = self.workspace / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        (self.workspace / '.cache/bin').mkdir(parents=True)
        (self.workspace / 'dist').mkdir()
        helm = self.workspace / '.cache/bin/helm'
        helm.write_text('#!/bin/sh\nexit 0\n')
        helm.chmod(0o700)
        self.digest = 'sha256:' + 'a' * 64
        self.metadata('build', self.digest)
        self.workers = {name: f'sha256:{index}' + 'c' * 63 for index, name in enumerate(['evaluator', 'automation', 'voice'])}
        for name, digest in self.workers.items():
            self.metadata(name + '-build', digest)
        versions = yaml.safe_load((ROOT / 'deploy/vars.yaml').read_text())
        harnesses = yaml.safe_load((ROOT / 'charts/agentos/values.yaml').read_text())['harnesses']
        self.images = {
            'controller': versions['kagent_controller_image'],
            'substrate-api': versions['substrate_api_image'],
            'substrate-microvm': versions['substrate_microvm_image'],
            'claude-harness': harnesses['claude']['workload']['image'],
            'standard-harness': harnesses['standard']['workload']['image'],
            'codex-harness': harnesses['codex']['workload']['image'],
        }

    def metadata(self, name, digest):
        path = self.workspace / f'.cache/{name}-metadata.json'
        path.write_text(json.dumps({'containerimage.digest': digest}))

    def package(self):
        return subprocess.run(
            [sys.executable, str(ROOT / 'ci/package-chart.py')],
            cwd=self.workspace, capture_output=True, text=True, env={**os.environ, 'CI_REGISTRY_IMAGE': REGISTRY},
        )

    def assert_release(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = json.loads((self.workspace / 'dist/release.json').read_text())
        self.assertEqual(release['image'], f'{REGISTRY}@{self.digest}')
        for name, image in self.images.items():
            self.assertEqual(release[name], f'{REGISTRY}/{relative(image)}')
        for name, digest in self.workers.items():
            self.assertEqual(release[name], f'{REGISTRY}/{name}@{digest}')
        values = yaml.safe_load((self.workspace / 'charts/agentos/values.yaml').read_text())
        self.assertEqual(values['image'], {'repository': REGISTRY, 'digest': self.digest})
        for harness in values['harnesses'].values():
            self.assertTrue(harness['workload']['image'].startswith(REGISTRY + '/'))

    def test_application_only_release_reuses_pinned_runtime_images(self):
        self.assert_release()

    def test_runtime_builds_match_the_deployment_pins(self):
        for name, image in self.images.items():
            self.metadata(name + '-build', image.split('@')[1])
        self.assert_release()

    def test_any_runtime_digest_mismatch_blocks_release(self):
        for name in self.images:
            with self.subTest(runtime=name):
                self.metadata(name + '-build', 'sha256:' + 'b' * 64)
                result = self.package()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'Published {name} image differs from the deployment pin', result.stderr)
                (self.workspace / f'.cache/{name}-build-metadata.json').unlink()


if __name__ == '__main__':
    unittest.main()
