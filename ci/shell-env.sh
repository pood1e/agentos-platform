#!/bin/sh
umask 022
if [ -n "${AGENTOS_CI_ENVIRONMENT:-}" ]; then
  . "$AGENTOS_CI_ENVIRONMENT"
fi
export AGENTOS_CI_CACHE="${AGENTOS_CI_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/agentos}"
export AGENTOS_GO_TOOLS="$AGENTOS_CI_CACHE/kagent-tools"
export GOLANGCI_LINT_CACHE="$AGENTOS_CI_CACHE/golangci-lint"
export GOTOOLCHAIN=local
export GOENV=off
export GOMAXPROCS=4
tools_root="$AGENTOS_CI_CACHE/tools/$(sha256sum ci/tools.sh | cut -d ' ' -f 1)"
mkdir -p .cache "$tools_root"
ln -sfn "$tools_root" .cache/bin
