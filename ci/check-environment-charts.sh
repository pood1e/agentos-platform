#!/bin/sh
set -eu
mkdir -p .cache/chart-check
go -C controller build -o ../.cache/chart-check/render ./cmd/render
for chart in agentos-environment agentos-connections; do
  values="charts/$chart/tests/values.json"
  helm lint "charts/$chart" -f "$values" --strict
  helm-unittest --strict "charts/$chart"
  helm template "$chart" "charts/$chart" -n agentos -f "$values" > ".cache/chart-check/$chart.yaml"
  .cache/chart-check/render < ".cache/chart-check/$chart.yaml" > ".cache/chart-check/$chart-expanded.yaml"
  mv ".cache/chart-check/$chart-expanded.yaml" ".cache/chart-check/$chart.yaml"
  kubeconform -strict -summary -kubernetes-version 1.37.1 \
    -schema-location default \
    -schema-location '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    ".cache/chart-check/$chart.yaml"
  conftest test --combine --policy tests/policies --namespace environment_tests --data "$values" ".cache/chart-check/$chart.yaml"
done
