#!/bin/sh
set -eu
umask 077
export DOCKER_CONFIG="$CI_PROJECT_DIR/.cache/build-auth"
mkdir -p "$DOCKER_CONFIG"
auth=$(printf '%s:%s' "$CI_REGISTRY_USER" "$CI_REGISTRY_PASSWORD" | base64 | tr -d '\n')
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$CI_REGISTRY" "$auth" > "$DOCKER_CONFIG/config.json"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
BUILDKITD_FLAGS=--oci-worker-no-process-sandbox
if [ -n "${AGENTOS_REGISTRY_MIRROR:-}" ]; then
  printf '[registry."docker.io"]\n  mirrors = ["%s"]\n' "$AGENTOS_REGISTRY_MIRROR" > "$CI_PROJECT_DIR/.cache/buildkit.toml"
  BUILDKITD_FLAGS="$BUILDKITD_FLAGS --config $CI_PROJECT_DIR/.cache/buildkit.toml"
fi
export BUILDKITD_FLAGS
set --
if [ -n "${AGENTOS_HARNESS_IMAGE:-}" ]; then
  set -- --opt "build-arg:HARNESS_IMAGE=$AGENTOS_HARNESS_IMAGE"
fi
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context="${AGENTOS_BUILD_CONTEXT:-.}" --local dockerfile="${AGENTOS_DOCKERFILE_DIR:-.}" \
  --opt platform=linux/amd64 \
  "$@" \
  --import-cache "type=registry,ref=$CI_REGISTRY_IMAGE${AGENTOS_IMAGE_SUFFIX:-}:buildcache" \
  --export-cache "type=registry,ref=$CI_REGISTRY_IMAGE${AGENTOS_IMAGE_SUFFIX:-}:buildcache,mode=max" \
  --output "type=image,name=$CI_REGISTRY_IMAGE${AGENTOS_IMAGE_SUFFIX:-}:$CI_COMMIT_SHA,push=true" \
  --metadata-file "${AGENTOS_BUILD_METADATA:-.cache/build-metadata.json}"
