#!/bin/sh
set -eu
mkdir -p .cache/bin
fetch() {
  name=$1 url=$2 digest=$3 member=$4
  if [ ! -x ".cache/bin/$name" ] || [ "$(cat ".cache/bin/$name.sha256" 2>/dev/null || true)" != "$digest" ]; then
    python3 - "$url" ".cache/$name.tar.gz" <<'PY'
import shutil
import sys
import time
import urllib.request

for attempt in range(3):
    try:
        with urllib.request.urlopen(sys.argv[1], timeout=60) as response, open(sys.argv[2], 'wb') as target:
            shutil.copyfileobj(response, target)
        break
    except OSError:
        if attempt == 2:
            raise
        time.sleep(2 ** attempt)
PY
    printf '%s  %s\n' "$digest" ".cache/$name.tar.gz" | sha256sum --check
    tar -xzf ".cache/$name.tar.gz" -C .cache "$member"
    mv ".cache/$member" ".cache/bin/$name"
    printf '%s\n' "$digest" > ".cache/bin/$name.sha256"
  fi
}
if [ "$#" -eq 0 ]; then set -- helm kubeconform; fi
for tool in "$@"; do
  case "$tool" in
    helm) fetch helm https://get.helm.sh/helm-v3.22.0-linux-amd64.tar.gz 1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb linux-amd64/helm ;;
    kubeconform) fetch kubeconform https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz 9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 kubeconform ;;
    fga) fetch fga https://github.com/openfga/cli/releases/download/v0.8.2/fga_0.8.2_linux_amd64.tar.gz e48c4a73cf68031fe9fc0827f1462a9b2d6981e3d2e9b82f1e1c2e120c293443 fga ;;
    openfga) fetch openfga https://github.com/openfga/openfga/releases/download/v1.22.0/openfga_1.22.0_linux_amd64.tar.gz eaa86a22c7ece1e461467082447fdf943bd2aca03ed400e31d5c82953d85cf14 openfga ;;
    *) printf 'Unknown tool: %s\n' "$tool" >&2; exit 1 ;;
  esac
done
