"""Mirror public release sources from inside the build network using a project-scoped deploy key."""

import re
import subprocess
import tempfile

SOURCE = "https://github.com/pood1e/agentos-platform.git"
TARGET = "git@gitlab.dev.supranett.com:aiops/agentos-platform.git"


def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, timeout=120)
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
target = refs(TARGET)
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
        git(
            "push",
            "--atomic",
            TARGET,
            *[f"{ref}:{ref}" for ref in changed],
            cwd=directory,
        )
    print("Synchronized", ", ".join(changed))
