#!/bin/sh
set -eu
task_root=$(pwd)
ci/prepare-substrate.sh
cd "$task_root/.cache/substrate-source"
go test -race -count=1 ./cmd/ateapi/internal/apivalidation ./cmd/ateapi/internal/defaults \
  ./cmd/ateapi/internal/controlapi ./internal/ateomtunnel ./internal/atunnel \
  ./cmd/atenet/internal/router/egress
# Network namespace tests run in the dedicated KVM runtime, outside this unprivileged runner.
go test -race -count=1 ./cmd/ateom-microvm \
  -skip '^(TestHostActorReplacesSameActor|TestSetupActorTap|TestSetupActorTapReplacesALeftover)$'
go test -race -count=1 ./cmd/ateapi/internal/store/atepg \
  -run 'TestContractSuite|TestCreateActor|TestUpdateActor'
mkdir -p "$task_root/.cache/substrate-image"
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' \
  -o "$task_root/.cache/substrate-image/ateapi" ./cmd/ateapi
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' \
  -o "$task_root/.cache/substrate-image/ateom-microvm" ./cmd/ateom-microvm
