#!/bin/sh
set -eu
task_root=$(pwd)
source_dir="$task_root/.cache/substrate-source"
upstream_commit=9c4b1fb52212028100fa02c8a7bc4526575ea37e
git clone --quiet --depth 1 --branch v0.5.0-alpha2 https://github.com/kagent-dev/substrate.git "$source_dir"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream_commit"
git -C "$source_dir" apply "$task_root/runtime/substrate/golden-skills.patch"
