#!/bin/sh
dependency_key=$(printf '%s\n' "$(sha256sum "$@")" "$(python3 --version)" | sha256sum | cut -d ' ' -f 1)
dependency_root="$AGENTOS_CI_CACHE/python/$dependency_key"
mkdir -p "$dependency_root"
(
  flock 9
  if [ ! -f "$dependency_root/ready" ]; then
    python3 -m venv "$dependency_root/venv"
    "$dependency_root/venv/bin/pip" install --disable-pip-version-check -r "$1"
    if [ "$#" -eq 2 ]; then
      ANSIBLE_COLLECTIONS_PATH="$dependency_root/collections" \
        "$dependency_root/venv/bin/ansible-galaxy" collection install -r "$2" -p "$dependency_root/collections"
    fi
    touch "$dependency_root/ready"
  fi
) 9>"$dependency_root/install.lock"
ln -sfn "$dependency_root/venv" .cache/venv
if [ "$#" -eq 2 ]; then
  ln -sfn "$dependency_root/collections" .cache/collections
fi
