#!/bin/sh
set -eu
cd "$(dirname "$0")/../deploy"
export ANSIBLE_CONFIG="$PWD/ansible.cfg"
export HELM_PLUGINS="$PWD/playbooks/deploy/helm-plugins"
pin() {
  python -c "import sys, yaml; print(yaml.safe_load(open('playbooks/deploy/vars.yaml'))[sys.argv[1]])" "$1"
}
ansible-lint
for playbook in install access connections deploy/validate; do
  ansible-playbook "playbooks/$playbook.yaml" --syntax-check
done
ansible-playbook tests/render-values.yaml
conftest verify --policy tests/policies
AGENTOS_KUSTOMIZE_OVERLAY="$PWD/playbooks/deploy/kustomize/substrate" \
  helm template substrate oci://ghcr.io/kagent-dev/substrate/helm/substrate \
  --version "$(pin substrate_version)" --post-renderer agentos-kustomize --namespace ate-system \
  -f .cache/check/substrate-values.yaml > .cache/check/native-substrate.yaml
AGENTOS_KUSTOMIZE_OVERLAY="$PWD/playbooks/deploy/kustomize/atelet" \
  helm template substrate-atelet oci://ghcr.io/kagent-dev/substrate/helm/substrate-atelet \
  --version "$(pin substrate_version)" --post-renderer agentos-kustomize --namespace ate-system \
  -f .cache/check/atelet-values.yaml > .cache/check/native-atelet.yaml
helm template openfga ".cache/check/runtime/openfga-$(pin openfga_chart_version).tgz" \
  --namespace agentos -f .cache/check/openfga-values.yaml > .cache/check/native-openfga.yaml
for scenario in .cache/check .cache/check/telemetry .cache/check/private-identity .cache/check/authorization; do
  AGENTOS_KUSTOMIZE_OVERLAY="$PWD/playbooks/deploy/kustomize/kagent" \
    AGENTOS_PATCHED_IMAGE="$(pin kagent_controller_image)" \
    helm template kagent ".cache/check/runtime/kagent-$(pin kagent_runtime_version).tgz" --post-renderer agentos-kustomize \
    --namespace agentos -f "$scenario/kagent-values.yaml" > "$scenario/native-kagent.yaml"
  conftest test --combine --policy tests/policies --namespace runtime_tests \
    --data .cache/check/test-data.json "$scenario/kagent-values.yaml" \
    .cache/check/substrate-values.yaml .cache/check/atelet-values.yaml "$scenario/native-kagent.yaml" .cache/check/runtime-ingress.yaml
done
python -m unittest discover -s tests
ruff check
ruff format --check
