"""Verify native workload image references in rendered Kubernetes resources."""

import argparse
import re
import subprocess
import sys

import yaml

parser = argparse.ArgumentParser()
for name in ("registry", "version", "revision", "key"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
images = set()


def collect(value):
    if isinstance(value, dict):
        image = value.get("image")
        if isinstance(image, str) and (
            image.startswith(args.registry + "/")
            or image.startswith(args.registry + "@")
            or image.startswith(args.registry + ":")
        ):
            if not re.fullmatch(r"[^@]+@sha256:[0-9a-f]{64}", image):
                raise ValueError("Platform image must use an immutable digest")
            images.add(image)
        for item in value.values():
            collect(item)
    elif isinstance(value, list):
        for item in value:
            collect(item)


for document in yaml.safe_load_all(sys.stdin):
    collect(document)
for image in sorted(images):
    subprocess.run(
        [
            "cosign",
            "verify",
            "--key",
            args.key,
            "--insecure-ignore-tlog",
            "-a",
            "version=" + args.version,
            "-a",
            "revision=" + args.revision,
            image,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
