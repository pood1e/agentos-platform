#!/bin/sh
set -eu
task_root=$(pwd)
tools_dir=${AGENTOS_GO_TOOLS:-$task_root/.cache/kagent-tools}
ci/prepare-substrate.sh
source_dir="$task_root/.cache/controller-source"
upstream_commit=30e8a2c2ceb9a1fadc16e969aa7ee0107a42d7b2
git clone --quiet --depth 1 --branch v1.0.0-alpha11 https://github.com/kagent-dev/kagent.git "$source_dir"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream_commit"
git -C "$source_dir" apply "$task_root/runtime/kagent/delete-memory-entry.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/golden-skills.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/claude-tool-selection.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/claude-skills.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/claude-approval-wait.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/mcp-approval-groups.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/actor-identity.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/runtime-api.patch"
git -C "$source_dir" apply "$task_root/runtime/kagent/workload-headers.patch"
cmp "$source_dir/proto/kagent/api/v1alpha1/memory.proto" "$task_root/third_party/kagent/kagent/api/v1alpha1/memory.proto"
cd "$source_dir/go"
go mod edit -replace=github.com/agent-substrate/substrate=../../substrate-source
test -z "$(gofmt -l core/internal/database/memory*.go core/internal/service/memory/*.go core/internal/grpcserver/memory*.go core/internal/dbtest/*.go core/internal/pgtest/*.go core/internal/substrate/policy.go core/internal/substrate/actor_identity_test.go core/internal/utils/runtime_api*.go api/a2a/runtime.go adk/pkg/controllerclient/*.go core/internal/translator/*/workload_identity_test.go)"
make setup-envtest GOTOOLCHAIN=local LOCALBIN="$tools_dir"
export KUBEBUILDER_ASSETS
KUBEBUILDER_ASSETS=$(make -s envtest-path GOTOOLCHAIN=local LOCALBIN="$tools_dir")
go test -race -count=1 ./core/internal/database ./core/pkg/migrations ./core/internal/service/memory ./core/internal/grpcserver ./core/internal/a2agateway ./core/internal/translator/adkconfig ./core/internal/substrate ./core/internal/translator ./core/internal/utils
go test -race -count=1 ./core/internal/translator/claude ./core/internal/translator/codex ./harness/claude/... ./harness/codex/... ./adk/pkg/controllerclient ./adk/pkg/taskstore
go test -race -count=1 ./core/internal/controller -run '^TestStatusForPairPublishesCompilationWarnings$'
make lint AWK=awk GOTOOLCHAIN=local \
  LOCALBIN="$tools_dir/golangci-v2.14.0" GOLANGCI_LINT_VERSION=v2.14.0
mkdir -p "$task_root/.cache/controller-image"
CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags '-s -w -X github.com/kagent-dev/kagent/go/core/internal/version.Version=1.0.0-alpha11-agentos.10 -X github.com/kagent-dev/kagent/go/core/internal/version.GitCommit=30e8a2c2ceb9a1fadc16e969aa7ee0107a42d7b2 -X github.com/kagent-dev/kagent/go/core/internal/version.SubstrateVersion=0.5.0-alpha2' \
  -o "$task_root/.cache/controller-image/kagent-controller" ./core/cmd/controller
mkdir -p "$task_root/.cache/claude-image"
cp "$task_root/runtime/harness-toolbox/install.sh" "$task_root/.cache/claude-image/install.sh"
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' \
  -o "$task_root/.cache/claude-image/kagent-claude" ./harness/claude/cmd

mkdir -p "$task_root/.cache/standard-image/rootfs" "$task_root/.cache/codex-image/rootfs/usr/local/bin"
for harness in standard codex; do
  cp "$task_root/runtime/harness-toolbox/install.sh" "$task_root/.cache/$harness-image/install.sh"
done
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' \
  -o "$task_root/.cache/standard-image/rootfs/app" ./adk/cmd
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w' \
  -o "$task_root/.cache/codex-image/rootfs/usr/local/bin/kagent-codex" ./harness/codex/cmd
