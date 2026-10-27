#!/bin/sh
set -eu
go -C controller run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.23.0 \
  object paths=./api/... crd:crdVersions=v1 output:crd:artifacts:config=../charts/agentos/crds
cp charts/agentos/crds/*.yaml charts/agentos-environment/crds/
