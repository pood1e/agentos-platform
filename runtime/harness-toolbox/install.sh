#!/bin/sh
set -eu
apk add --no-cache bash ca-certificates coreutils curl findutils git iproute2 iputils \
  jq openssh-client procps py3-pip python3 ripgrep tar unzip
ln -sf /usr/bin/python3 /usr/local/bin/python
if ! getent group 65532 >/dev/null; then
  addgroup -S -g 65532 kagent
fi
if ! getent passwd 65532 >/dev/null; then
  adduser -S -D -H -u 65532 -G "$(getent group 65532 | cut -d: -f1)" -h /data -s /bin/bash kagent
fi
mkdir -p /data/workspace
chown 65532:65532 /data/workspace
python3 -c 'import json, ssl, urllib.request, venv'
python -m venv /tmp/toolbox-check
/tmp/toolbox-check/bin/pip --version
rm -rf /tmp/toolbox-check
