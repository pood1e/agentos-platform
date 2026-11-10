#!/bin/sh
# Build and push one image for one architecture under an architecture tag; build-index merges them.
set -eu
. ci/registry-auth.sh
set --
if [ -n "${AGENTOS_HARNESS_IMAGE:-}" ]; then
  set -- --build-arg "HARNESS_IMAGE=$AGENTOS_HARNESS_IMAGE"
fi
image="$CI_REGISTRY_IMAGE${AGENTOS_IMAGE_SUFFIX:-}"
metadata=${AGENTOS_BUILD_METADATA:-.cache/build-metadata.json}
images=".cache/images/$(basename "$metadata" .json)"
mkdir -p "$images"
docker buildx build \
  --platform "linux/$AGENTOS_ARCH" \
  --file "${AGENTOS_DOCKERFILE_DIR:-.}/Dockerfile" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --label "org.opencontainers.image.source=$CI_PROJECT_URL" \
  "$@" \
  --cache-from "type=registry,ref=$image:buildcache-$AGENTOS_ARCH" \
  --cache-to "type=registry,ref=$image:buildcache-$AGENTOS_ARCH,mode=max" \
  --provenance=false \
  --tag "$image:$CI_COMMIT_SHA-$AGENTOS_ARCH" \
  --push \
  --metadata-file "$images/$AGENTOS_ARCH.json" \
  "${AGENTOS_BUILD_CONTEXT:-.}"
printf '%s\n' "$image" > "$images/repository"
