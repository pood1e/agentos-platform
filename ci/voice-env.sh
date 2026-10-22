#!/bin/sh
voice_uv=.cache/venv/bin/uv
voice_key=$(cat voice/requirements.lock ci/voice-test-requirements.txt | sha256sum | cut -d ' ' -f 1)
voice_root="$AGENTOS_CI_CACHE/voice/python-3.13.15/$voice_key"
mkdir -p "$voice_root"
(
  flock 9
  if [ ! -f "$voice_root/ready" ]; then
    "$voice_uv" venv --python 3.13.15 "$voice_root/venv"
    "$voice_uv" pip install --python "$voice_root/venv/bin/python" --require-hashes -r voice/requirements.lock
    "$voice_uv" pip install --python "$voice_root/venv/bin/python" -r ci/voice-test-requirements.txt
    touch "$voice_root/ready"
  fi
) 9>"$voice_root/install.lock"
ln -sfn "$voice_root/venv" .cache/voice-venv
