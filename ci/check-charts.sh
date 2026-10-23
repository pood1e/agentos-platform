#!/bin/sh
set -eu
ci/tools.sh helm helm-unittest conftest kubeconform
.cache/venv/bin/python ci/chart-schemas.py
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/venv/bin/ansible-playbook ci/render-chart-values.yaml
.cache/venv/bin/python -m unittest discover -s tests/deployment
.cache/bin/conftest verify --policy tests/policies
.cache/bin/helm-unittest --strict charts/agentos
.cache/bin/helm dependency build tests/fixtures/solution-chart --skip-refresh
.cache/bin/helm lint charts/agentos -f tests/fixtures/chart-values.yaml --strict
.cache/bin/helm lint tests/fixtures/solution-chart --strict
.cache/bin/helm template agentos charts/agentos -n agentos -f tests/fixtures/chart-values.yaml > .cache/chart-check/platform.yaml
.cache/bin/helm template agentos charts/agentos -n operations -f tests/fixtures/chart-values.yaml \
  --set-string kagent.userId=operations-owner > .cache/chart-check/alternate.yaml
.cache/bin/helm template agentos tests/fixtures/solution-chart -n agentos > .cache/chart-check/solution.yaml
.cache/bin/helm template agentos tests/fixtures/solution-chart -n agentos -f .cache/chart-check/direct-values.json > .cache/chart-check/direct-only.yaml
for name in platform alternate solution direct-only; do
  .cache/bin/kubeconform -strict -summary -kubernetes-version 1.37.1 \
    -schema-location default \
    -schema-location '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    ".cache/chart-check/$name.yaml"
  case "$name" in
    solution) set -- --data tests/fixtures/solution-chart/values.yaml ;;
    direct-only) set -- --data .cache/chart-check/direct-values.json ;;
    *) set -- ;;
  esac
  .cache/bin/conftest test --combine --policy tests/policies --namespace main \
    --data .cache/chart-check/test-data.json "$@" ".cache/chart-check/$name.yaml"
done
kagent_version=$(.cache/venv/bin/python -c "import yaml; print(yaml.safe_load(open('deploy/vars.yaml'))['kagent_version'])")
.cache/bin/helm template kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent \
  --version "$kagent_version" -f .cache/chart-check/kagent-values.yaml > .cache/chart-check/native-kagent.yaml
.cache/bin/conftest test --combine --policy tests/policies --namespace runtime_tests \
  --data .cache/chart-check/test-data.json .cache/chart-check/kagent-values.yaml \
  .cache/chart-check/substrate-values.yaml .cache/chart-check/native-kagent.yaml runtime/kagent/Dockerfile
ci/check-environment-charts.sh
