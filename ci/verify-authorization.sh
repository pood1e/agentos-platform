#!/bin/sh
set -eu
ci/tools.sh fga
for model in authorization/*.fga.yaml; do
  .cache/bin/fga model test --tests "$model"
done
