"""Mirror public release sources from inside the build network using the current job token."""

import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request

SOURCE = "https://github.com/pood1e/agentos-platform.git"


def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Source synchronization failed during git {args[0]}")
    return result.stdout.strip()


def refs(remote):
    return {
        ref: sha
        for sha, ref in (line.split() for line in git("ls-remote", "--refs", remote).splitlines())
        if ref == "refs/heads/main" or re.fullmatch(r"refs/tags/v\d+\.\d+\.\d+", ref)
    }


source = refs(SOURCE)
target = refs(os.environ["CI_REPOSITORY_URL"])
changed = [ref for ref, sha in source.items() if target.get(ref) != sha]
for ref in changed:
    if ref.startswith("refs/tags/") and ref in target:
        raise ValueError("A release tag changed upstream; immutable tag synchronization refused")
if not changed:
    print("Source and build repositories are synchronized")
else:
    with tempfile.TemporaryDirectory(prefix="agentos-source-") as directory:
        git("init", "--bare", directory)
        git("fetch", "--no-tags", SOURCE, *[f"{ref}:{ref}" for ref in changed], cwd=directory)
        revisions = {ref: git("rev-parse", f"{ref}^{{commit}}", cwd=directory) for ref in changed}
        git(
            "push",
            "--atomic",
            os.environ["CI_REPOSITORY_URL"],
            *[f"{ref}:{ref}" for ref in changed],
            cwd=directory,
        )
    # Job-token pushes deliberately do not start CI. Trigger one pipeline for each new ref.
    for ref, revision in revisions.items():
        body = urllib.parse.urlencode(
            {
                "token": os.environ["CI_JOB_TOKEN"],
                "ref": ref.removeprefix("refs/heads/").removeprefix("refs/tags/"),
            }
        ).encode()
        url = (
            f"{os.environ['CI_API_V4_URL']}/projects/{os.environ['CI_PROJECT_ID']}/trigger/pipeline"
        )
        with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=30) as response:
            pipeline = json.load(response)
        if pipeline["sha"] != revision:
            raise ValueError("Triggered pipeline revision differs from the mirrored source")
        print("Synchronized", ref, revision, "pipeline", pipeline["id"])
