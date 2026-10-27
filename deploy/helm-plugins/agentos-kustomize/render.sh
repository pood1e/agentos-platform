#!/bin/sh
set -eu
umask 077
render_dir=$(mktemp -d)
trap 'rm -rf "$render_dir"' EXIT
cp -R "${AGENTOS_KUSTOMIZE_OVERLAY:?}/." "$render_dir/"
cat > "$render_dir/resources.yaml"
cd "$render_dir"
kustomize edit set image "agentos-patched-image=${AGENTOS_PATCHED_IMAGE:?}"
kustomize build .
