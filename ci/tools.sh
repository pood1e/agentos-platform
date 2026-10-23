#!/bin/sh
set -eu
mkdir -p .cache/bin
fetch() {
  name=$1 url=$2 digest=$3 member=$4
  if [ ! -x ".cache/bin/$name" ] || [ "$(cat ".cache/bin/$name.sha256" 2>/dev/null || true)" != "$digest" ]; then
    case "$url" in
      *.zip) archive=".cache/$name.zip" ;;
      *) archive=".cache/$name.tar.gz" ;;
    esac
    python3 - "$url" "$archive" <<'PY'
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
    printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
    case "$url" in
      *.zip)
        python3 - "$archive" "$member" ".cache/bin/$name" <<'PY'
from pathlib import Path
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    Path(sys.argv[3]).write_bytes(archive.read(sys.argv[2]))
PY
        chmod +x ".cache/bin/$name"
        ;;
      *)
        tar -xzf "$archive" -C .cache "$member"
        mv ".cache/$member" ".cache/bin/$name"
        ;;
    esac
    printf '%s\n' "$digest" > ".cache/bin/$name.sha256"
  fi
}
if [ "$#" -eq 0 ]; then set -- helm kubeconform; fi
for tool in "$@"; do
  case "$tool" in
    helm) fetch helm https://get.helm.sh/helm-v3.22.0-linux-amd64.tar.gz 1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb linux-amd64/helm ;;
    kubeconform) fetch kubeconform https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz 9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 kubeconform ;;
    helm-unittest) fetch helm-unittest https://github.com/helm-unittest/helm-unittest/releases/download/v1.2.1/helm-unittest-linux-amd64-1.2.1.tgz 48e86ecc1467b009630e5954375e5d8494139f73b466df5fe8c04fa45b634939 untt-linux-amd64 ;;
    conftest) fetch conftest https://github.com/open-policy-agent/conftest/releases/download/v0.71.1/conftest_0.71.1_Linux_x86_64.tar.gz c3f6b2a753bd56e377a1e51a95ae3e057f926f2e9139f7d5b5dfbbaf810f7985 conftest ;;
    protoc) fetch protoc https://github.com/protocolbuffers/protobuf/releases/download/v36.2/protoc-36.2-linux-x86_64.zip 121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278 bin/protoc ;;
    jsonschema)
      if [ ! -x .cache/bin/protoc-gen-jsonschema ] || [ "$(cat .cache/bin/protoc-gen-jsonschema.version 2>/dev/null || true)" != v0.6.0 ]; then
        GOBIN="$(cd .cache/bin && pwd)" go install github.com/bufbuild/protoschema-plugins/cmd/protoc-gen-jsonschema@v0.6.0
        printf '%s\n' v0.6.0 > .cache/bin/protoc-gen-jsonschema.version
      fi
      ;;
    *) printf 'Unknown tool: %s\n' "$tool" >&2; exit 1 ;;
  esac
done
