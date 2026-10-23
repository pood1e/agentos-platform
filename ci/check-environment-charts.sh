#!/bin/sh
set -eu
ci/tools.sh helm helm-unittest conftest kubeconform
mkdir -p .cache/chart-check
.cache/bin/helm-unittest --strict charts/agentos -f tests/presets_test.yaml
for chart in agentos-environment agentos-connections; do
  values="charts/$chart/tests/values.json"
  .cache/bin/helm lint "charts/$chart" -f "$values" --strict
  .cache/bin/helm-unittest --strict "charts/$chart"
  .cache/bin/helm template "$chart" "charts/$chart" -n agentos -f "$values" > ".cache/chart-check/$chart.yaml"
  .cache/bin/kubeconform -strict -summary -kubernetes-version 1.37.1 \
    -schema-location default \
    -schema-location '.cache/chart-check/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    ".cache/chart-check/$chart.yaml"
  .cache/bin/conftest test --combine --policy tests/policies/environments.rego --data "$values" ".cache/chart-check/$chart.yaml"
done
