#!/bin/sh
set -eu
# Proto copies match the pinned native source revisions.
task_root=$(pwd)
sources="$task_root/.cache/runtime-sources"
fetch() {
  rm -rf "$sources/$1"
  git init --quiet "$sources/$1"
  git -C "$sources/$1" remote add origin "https://github.com/$2.git"
  git -C "$sources/$1" fetch --quiet --depth 1 origin "$3"
  git -C "$sources/$1" checkout --quiet --detach FETCH_HEAD
  test "$(git -C "$sources/$1" rev-parse HEAD)" = "$3"
}
fetch kagent pood1e/kagent f86dfd5dea88c7438e9b63168055b50c768f52ac
fetch substrate kagent-dev/substrate 563df06f6be751c101539986896c17c55aa22a9d
git ls-files 'third_party/kagent/**/*.proto' | while IFS= read -r proto; do
  cmp "$sources/kagent/proto/${proto#third_party/kagent/}" "$task_root/$proto"
done
cmp "$sources/kagent/helm/kagent-crds/templates/api.kagent.dev_harnesses.yaml" "$task_root/third_party/kagent-crds/harnesses.yaml"
cmp "$sources/kagent/go/adk/pkg/declarative/schema.json" "$task_root/third_party/kagent-crds/workflow.schema.json"
cmp "$sources/substrate/api/ateapi/v1/ateapi.proto" "$task_root/third_party/substrate/api/ateapi/v1/ateapi.proto"
