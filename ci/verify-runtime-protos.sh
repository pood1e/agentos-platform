#!/bin/sh
set -eu
# Proto copies match the fork commits that publish the pinned runtime images.
task_root=$(pwd)
sources="$task_root/.cache/runtime-sources"
fetch() {
  rm -rf "$sources/$1"
  git init --quiet "$sources/$1"
  git -C "$sources/$1" remote add origin "https://github.com/pood1e/$1.git"
  git -C "$sources/$1" fetch --quiet --depth 1 origin "$2"
  git -C "$sources/$1" checkout --quiet --detach FETCH_HEAD
  test "$(git -C "$sources/$1" rev-parse HEAD)" = "$2"
}
fetch kagent d982c91dd64dfa1004643d58846df68be902b0d2
fetch substrate dece7140130772d0ab4ad66fc000f88c2e2687a1
git ls-files 'third_party/kagent/**/*.proto' | while IFS= read -r proto; do
  cmp "$sources/kagent/proto/${proto#third_party/kagent/}" "$task_root/$proto"
done
cmp "$sources/substrate/pkg/proto/ateapipb/ateapi.proto" "$task_root/third_party/substrate/ateapi.proto"
