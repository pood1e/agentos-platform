"""Serialize release artifacts using the public protobuf contract."""

import hashlib
import sys
from pathlib import Path

from google.protobuf.json_format import MessageToJson

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gen/python"))
from agentos.distribution.v1.release_pb2 import Artifact, ReleaseManifest


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def manifest(version, artifacts):
    return (
        MessageToJson(
            ReleaseManifest(
                revision=version.revision,
                version=version.semver,
                python_version=version.python,
                artifacts={
                    name: Artifact(location=location, digest=checksum)
                    for name, (location, checksum) in artifacts.items()
                },
            ),
            sort_keys=True,
            indent=2,
        ).encode()
        + b"\n"
    )
