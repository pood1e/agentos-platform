#!/bin/sh
set -eu
. ci/registry-auth.sh
set --
if [ -n "${AGENTOS_HARNESS_IMAGE:-}" ]; then
  set -- --build-arg "HARNESS_IMAGE=$AGENTOS_HARNESS_IMAGE"
fi
image="$CI_REGISTRY_IMAGE${AGENTOS_IMAGE_SUFFIX:-}"
metadata_file=${AGENTOS_BUILD_METADATA:-.cache/build-metadata.json}
mkdir -p "$(dirname "$metadata_file")"
docker buildx build \
  --platform linux/amd64 \
  --file "${AGENTOS_DOCKERFILE_DIR:-.}/Dockerfile" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --label "org.opencontainers.image.source=$CI_PROJECT_URL" \
  "$@" \
  --cache-from "type=registry,ref=$image:buildcache" \
  --cache-to "type=registry,ref=$image:buildcache,mode=max" \
  --provenance=false \
  --tag "$image:$CI_COMMIT_SHA" \
  --push \
  --metadata-file "$metadata_file" \
  "${AGENTOS_BUILD_CONTEXT:-.}"
printf '%s\n' "$image:$CI_COMMIT_SHA" > "${metadata_file%.json}.ref"
