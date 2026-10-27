#!/bin/sh
set -eu
go -C controller run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.23.0 \
  object paths=./api/... crd:crdVersions=v1 output:crd:artifacts:config=config/crd/bases
for chart in agentos agentos-environment; do
  rm -rf "charts/$chart/crds"
  mkdir -p "charts/$chart/crds"
  cp controller/config/crd/bases/*.yaml "charts/$chart/crds/"
done
