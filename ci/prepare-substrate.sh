#!/bin/sh
set -eu
task_root=$(pwd)
source_dir="$task_root/.cache/substrate-source"
upstream_commit=e2fc0fa9f77ab5fc09eb01b43ccd74bd84c67c71
git clone --quiet --depth 1 --branch v0.6.0-alpha3 https://github.com/kagent-dev/substrate.git "$source_dir"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream_commit"
git -C "$source_dir" apply --index "$task_root/runtime/substrate/golden-skills.patch"
cmp "$source_dir/pkg/proto/ateapipb/ateapi.proto" "$task_root/third_party/substrate/ateapi.proto"
