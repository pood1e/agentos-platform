#!/bin/sh
# Publish each image built per architecture as one multi-arch index tagged with the commit.
set -eu
. ci/registry-auth.sh
for images in .cache/images/*/; do
  image=$(cat "${images}repository")
  set --
  for metadata in "${images}"*.json; do
    set -- "$@" "$image@$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$metadata")"
  done
  docker buildx imagetools create --tag "$image:$CI_COMMIT_SHA" "$@"
  digest=$(docker buildx imagetools inspect "$image:$CI_COMMIT_SHA" --format '{{json .Manifest}}' \
    | grep -m1 '"digest"' | sed 's/.*"\(sha256:[0-9a-f]*\)".*/\1/')
  [ "${#digest}" -eq 71 ] || { echo "Unexpected index digest for $image: $digest" >&2; exit 1; }
  name=$(basename "$images")
  printf '{"containerimage.digest": "%s"}\n' "$digest" > ".cache/$name.json"
  printf '%s\n' "$image:$CI_COMMIT_SHA" > ".cache/$name.ref"
done
