#!/bin/sh
set -eu
. ci/kubernetes-schemas.sh
mkdir -p .cache/chart-check .cache/kubeconform
go -C controller build -o ../.cache/chart-check/render ./cmd/render
for chart in agentos-environment agentos-connections; do
  values="charts/$chart/tests/values.json"
  helm lint "charts/$chart" -f "$values" --strict
  helm-unittest --strict "charts/$chart"
  helm template "$chart" "charts/$chart" -n agentos -f "$values" > ".cache/chart-check/$chart.yaml"
  .cache/chart-check/render < ".cache/chart-check/$chart.yaml" > ".cache/chart-check/$chart-expanded.yaml"
  mv ".cache/chart-check/$chart-expanded.yaml" ".cache/chart-check/$chart.yaml"
  kubeconform -strict -summary -cache .cache/kubeconform -kubernetes-version 1.37.1 \
    -schema-location '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    -schema-location "$KUBERNETES_SCHEMA_LOCATION" \
    ".cache/chart-check/$chart.yaml"
  conftest test --combine --policy tests/policies --namespace environment_tests --data "$values" ".cache/chart-check/$chart.yaml"
done
