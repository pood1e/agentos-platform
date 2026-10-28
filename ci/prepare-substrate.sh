#!/bin/sh
set -eu
task_root=$(pwd)
source_dir="$task_root/.cache/substrate-source"
source_commit=776c8825a8207993fc15b132714ef670eb28120f
git init --quiet "$source_dir"
git -C "$source_dir" remote add origin https://github.com/pood1e/substrate.git
git -C "$source_dir" fetch --quiet --depth 1 origin "$source_commit"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_commit"
cmp "$source_dir/pkg/proto/ateapipb/ateapi.proto" "$task_root/third_party/substrate/ateapi.proto"
