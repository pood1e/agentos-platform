#!/bin/sh
set -eu
ci/generate-controller.sh
git diff --exit-code -- controller/api controller/config/crd/bases
helm dependency build charts/agentos --skip-refresh
helm dependency build charts/agentos-environment --skip-refresh
mkdir -p .cache/chart-check
go -C controller build -o ../.cache/chart-check/render ./cmd/render
python ci/chart-schemas.py
python ci/chart-fixtures.py
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
  namespace=agentos
  if [ "$name" = alternate ]; then namespace=operations; fi
  .cache/chart-check/render -namespace="$namespace" < ".cache/chart-check/$name.yaml" > ".cache/chart-check/$name-expanded.yaml"
  mv ".cache/chart-check/$name-expanded.yaml" ".cache/chart-check/$name.yaml"
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
ci/check-environment-charts.sh
