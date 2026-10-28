"""Build and verify native OCI coordinates for a single source revision."""

import gzip
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path

from versions import versions

PLACEHOLDER = "registry.example.com/agentos"


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def images():
    revision = versions().revision
    registry = os.environ["CI_REGISTRY_IMAGE"]
    result = {}
    for metadata in sorted(Path(".cache").glob("*build-metadata.json")):
        if metadata.name == "ci-tools-build-metadata.json":
            continue
        tagged = metadata.with_suffix(".ref").read_text().strip()
        repository, tag = tagged.rsplit(":", 1)
        if tag != revision or not (repository == registry or repository.startswith(registry + "/")):
            raise ValueError(f"Unexpected build source: {metadata}")
        digest = json.loads(metadata.read_text())["containerimage.digest"]
        reference = repository + "@" + digest
        configuration = json.loads(run("crane", "config", reference))
        if (
            configuration.get("config", {})
            .get("Labels", {})
            .get("org.opencontainers.image.revision")
            != revision
        ):
            raise ValueError(f"Image revision differs: {repository}")
        result[repository.removeprefix(registry)] = reference
    if not result:
        raise ValueError("No images built from this revision")
    return result


def replace_images(value, built):
    if isinstance(value, dict):
        return {key: replace_images(item, built) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_images(item, built) for item in value]
    if isinstance(value, str):
        for prefix in (PLACEHOLDER, "{{ agentos_image_registry }}"):
            if value.startswith(prefix + "/"):
                suffix = value.removeprefix(prefix).split("@", 1)[0].split(":", 1)[0]
                if suffix not in built:
                    raise ValueError(f"Missing current-source image: {suffix}")
                return built[suffix]
    return value


def reproducible(archive):
    epoch = int(run("git", "show", "-s", "--format=%ct", "HEAD"))
    with tarfile.open(archive) as original:
        members = [
            (item, original.extractfile(item).read() if item.isfile() else None)
            for item in original.getmembers()
        ]
    with (
        archive.open("wb") as output,
        gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=epoch) as compressed,
        tarfile.open(fileobj=compressed, mode="w") as packed,
    ):
        for item, content in sorted(members, key=lambda member: member[0].name):
            item.mtime, item.uid, item.gid, item.uname, item.gname = epoch, 0, 0, "", ""
            item.pax_headers = {}
            packed.addfile(item, io.BytesIO(content) if content is not None else None)


def descriptor(reference):
    result = subprocess.run(
        ["oras", "manifest", "fetch", "--descriptor", reference], text=True, capture_output=True
    )
    if result.returncode == 0:
        return json.loads(result.stdout)["digest"]
    if any(marker in result.stderr.lower() for marker in ("not found", "manifest_unknown", "404")):
        return None
    raise RuntimeError(result.stderr)


def sign(reference):
    version = versions()
    subprocess.run(
        [
            "cosign",
            "sign",
            "--yes",
            "--key",
            os.environ["COSIGN_PRIVATE_KEY"],
            "--signing-config",
            "ci/signing-config.json",
            "-a",
            "version=" + version.semver,
            "-a",
            "revision=" + version.revision,
            reference,
        ],
        check=True,
    )
    subprocess.run(
        [
            "cosign",
            "verify",
            "--key",
            "ci/cosign.pub",
            "--insecure-ignore-tlog",
            "-a",
            "version=" + version.semver,
            "-a",
            "revision=" + version.revision,
            reference,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def login():
    password = os.environ["CI_REGISTRY_PASSWORD"]
    for command in (("crane", "auth", "login"), ("oras", "login"), ("helm", "registry", "login")):
        subprocess.run(
            [
                *command,
                os.environ["CI_REGISTRY"],
                "--username",
                os.environ["CI_REGISTRY_USER"],
                "--password-stdin",
            ],
            input=password,
            text=True,
            check=True,
            capture_output=True,
        )
