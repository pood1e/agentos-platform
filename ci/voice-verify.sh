#!/bin/sh
set -eu
. ci/registry-auth.sh
docker run --rm --user "$(id -u):$(id -g)" --entrypoint "" --env PIP_INDEX_URL \
  --volume "$CI_PROJECT_DIR:/workspace:ro" --workdir /workspace \
  "$CI_REGISTRY_IMAGE/voice:$CI_COMMIT_SHA" sh -ec '
    python -m venv --system-site-packages /tmp/voice-venv
    /tmp/voice-venv/bin/pip install --quiet -r ci/voice-test-requirements.txt
    /tmp/voice-venv/bin/ruff check --no-cache voice
    /tmp/voice-venv/bin/ruff format --no-cache --check voice
    /tmp/voice-venv/bin/pytest -p no:cacheprovider -o pythonpath=voice voice/tests'
