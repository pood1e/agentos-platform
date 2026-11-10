# Sourced by shell-runner jobs: the mise.lock toolchain, a job-local CI Python
# environment and job-local registry credentials.
mkdir -p .cache
mise install --locked
eval "$(mise env --shell bash)"
uv venv --quiet --clear --python "$(mise which python)" .cache/venv
uv pip install --quiet --python .cache/venv/bin/python -r ci/python-requirements.txt -r contracts/requirements.txt
export PATH="$CI_PROJECT_DIR/.cache/venv/bin:$PATH"
export DOCKER_CONFIG="$CI_PROJECT_DIR/.cache/registry"
export HELM_REGISTRY_CONFIG="$DOCKER_CONFIG/helm.json"
