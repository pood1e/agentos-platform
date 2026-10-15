#!/bin/sh
set -eu
mkdir -p .cache/bin
fetch() {
  name=$1 url=$2 digest=$3 member=$4
  if [ ! -x ".cache/bin/$name" ]; then
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
  fi
}
fetch helm https://get.helm.sh/helm-v3.22.0-linux-amd64.tar.gz 1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb linux-amd64/helm
fetch kubeconform https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz 9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 kubeconform
