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
fetch kagent pood1e/kagent 2d5c4a62c06df47cc7ae48f11905838f51264a49
fetch substrate kagent-dev/substrate 71b1f9ec80848f8fd46f5d5d7e6b84ba36a80966
git ls-files 'third_party/kagent/**/*.proto' | while IFS= read -r proto; do
  cmp "$sources/kagent/proto/${proto#third_party/kagent/}" "$task_root/$proto"
done
cmp "$sources/kagent/helm/kagent-crds/templates/api.kagent.dev_harnesses.yaml" "$task_root/third_party/kagent-crds/harnesses.yaml"
cmp "$sources/kagent/go/adk/pkg/declarative/schema.json" "$task_root/third_party/kagent-crds/workflow.schema.json"
cmp "$sources/substrate/api/ateapi/v1/ateapi.proto" "$task_root/third_party/substrate/api/ateapi/v1/ateapi.proto"
