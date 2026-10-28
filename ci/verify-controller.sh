#!/bin/sh
set -eu
task_root=$(pwd)
ci/prepare-substrate.sh
source_dir="$task_root/.cache/controller-source"
source_commit=20923c71615472faa904d42c866177811c4c5a1b
git init --quiet "$source_dir"
git -C "$source_dir" remote add origin https://github.com/pood1e/kagent.git
git -C "$source_dir" fetch --quiet --depth 1 origin "$source_commit"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_commit"
git ls-files 'third_party/kagent/**/*.proto' | while IFS= read -r proto; do
  cmp "$source_dir/proto/${proto#third_party/kagent/}" "$task_root/$proto"
done
cd "$source_dir/go"
go mod edit -replace=go.ate.dev/substrate=../../substrate-source
go test -race -count=1 ./api/a2a ./core/internal/database ./core/pkg/migrations ./core/internal/runtimeauth ./core/internal/service/memory ./core/internal/service/taskstore ./core/internal/service/session ./core/internal/service/tool ./core/internal/service/scheduledrun ./core/internal/controller/scheduledrun ./core/internal/grpcserver ./core/internal/a2agateway ./core/internal/mcp ./core/internal/translator/adkconfig ./core/internal/substrate ./core/internal/translator ./core/internal/utils
go test -race -count=1 ./core/internal/translator/claude ./core/internal/translator/codex ./harness/... ./adk/pkg/a2a ./adk/pkg/tools ./adk/pkg/controllerclient ./adk/pkg/taskstore ./adk/pkg/embedding
go test -race -count=1 ./core/internal/controller -run '^TestStatusForPairPublishesCompilationWarnings$'
make lint AWK=awk
mkdir -p "$task_root/.cache/controller-image"
CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags "-s -w -X github.com/kagent-dev/kagent/go/core/internal/version.Version=1.0.0-alpha17-agentos.4 -X github.com/kagent-dev/kagent/go/core/internal/version.GitCommit=$source_commit -X github.com/kagent-dev/kagent/go/core/internal/version.SubstrateVersion=0.6.0-alpha3" \
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
