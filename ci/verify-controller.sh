#!/bin/sh
set -eu
task_root=$(pwd)
ci/prepare-substrate.sh
source_dir="$task_root/.cache/controller-source"
upstream_commit=8392184232e9c78196433a34b1fd3b33db5fcb97
git clone --quiet --depth 1 --branch v1.0.0-alpha17 https://github.com/kagent-dev/kagent.git "$source_dir"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream_commit"
git -C "$source_dir" apply --index "$task_root/runtime/kagent/platform.patch"
cmp "$source_dir/proto/kagent/runtime/v1/memory.proto" "$task_root/third_party/kagent/kagent/runtime/v1/memory.proto"
(
  cd "$source_dir"
  git diff --cached --name-only -- '*.go' | xargs gofmt -l > "$task_root/.cache/controller-format.txt"
  test ! -s "$task_root/.cache/controller-format.txt"
)
cd "$source_dir/go"
go mod edit -replace=go.ate.dev/substrate=../../substrate-source
go test -race -count=1 ./core/internal/database ./core/pkg/migrations ./core/internal/service/memory ./core/internal/service/tool ./core/internal/grpcserver ./core/internal/a2agateway ./core/internal/translator/adkconfig ./core/internal/substrate ./core/internal/translator ./core/internal/utils
go test -race -count=1 ./core/internal/translator/claude ./core/internal/translator/codex ./harness/claude/... ./harness/codex/... ./adk/pkg/controllerclient ./adk/pkg/taskstore ./adk/pkg/embedding
go test -race -count=1 ./core/internal/controller -run '^TestStatusForPairPublishesCompilationWarnings$'
make lint AWK=awk
mkdir -p "$task_root/.cache/controller-image"
CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags '-s -w -X github.com/kagent-dev/kagent/go/core/internal/version.Version=1.0.0-alpha17-agentos.2 -X github.com/kagent-dev/kagent/go/core/internal/version.GitCommit=8392184232e9c78196433a34b1fd3b33db5fcb97 -X github.com/kagent-dev/kagent/go/core/internal/version.SubstrateVersion=0.6.0-alpha3' \
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
