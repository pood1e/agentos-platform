#!/bin/sh
set -eu
python ci/chart-schemas.py
ANSIBLE_CONFIG=deploy/ansible.cfg ansible-playbook ci/render-chart-values.yaml
python -m unittest discover -s tests/deployment
conftest verify --policy tests/policies
helm-unittest --strict charts/agentos
helm dependency update tests/fixtures/solution-chart --skip-refresh
helm lint charts/agentos -f tests/fixtures/chart-values.yaml --strict
helm lint tests/fixtures/solution-chart --strict
helm template agentos charts/agentos -n agentos -f tests/fixtures/chart-values.yaml > .cache/chart-check/platform.yaml
helm template agentos charts/agentos -n operations -f tests/fixtures/chart-values.yaml \
  --set-string kagent.userId=operations-owner > .cache/chart-check/alternate.yaml
helm template agentos tests/fixtures/solution-chart -n agentos > .cache/chart-check/solution.yaml
helm template agentos tests/fixtures/solution-chart -n agentos -f .cache/chart-check/direct-values.json > .cache/chart-check/direct-only.yaml
for name in platform alternate solution direct-only; do
  kubeconform -strict -summary -kubernetes-version 1.37.1 \
    -schema-location default \
    -schema-location '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    ".cache/chart-check/$name.yaml"
  case "$name" in
    solution) set -- --data tests/fixtures/solution-chart/values.yaml ;;
    direct-only) set -- --data .cache/chart-check/direct-values.json ;;
    *) set -- ;;
  esac
  conftest test --combine --policy tests/policies --namespace main \
    --data .cache/chart-check/test-data.json "$@" ".cache/chart-check/$name.yaml"
done
kagent_version=$(python -c "import yaml; print(yaml.safe_load(open('deploy/vars.yaml'))['kagent_version'])")
helm template kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent \
  --version "$kagent_version" -f .cache/chart-check/kagent-values.yaml > .cache/chart-check/native-kagent.yaml
conftest test --combine --policy tests/policies --namespace runtime_tests \
  --data .cache/chart-check/test-data.json .cache/chart-check/kagent-values.yaml \
  .cache/chart-check/substrate-values.yaml .cache/chart-check/native-kagent.yaml runtime/kagent/Dockerfile
ci/check-environment-charts.sh
