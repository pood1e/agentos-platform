# Stages the pinned micro-VM assets listed in the manifest into the output directory.
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import urllib.request

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
out = pathlib.Path(sys.argv[2])
for source in manifest["sources"]:
    with urllib.request.urlopen(source["url"], timeout=60) as response:
        if "members" not in source:
            with (out / source["asset"]).open("wb") as f:
                shutil.copyfileobj(response, f)
            continue
        wanted = {path: asset for asset, path in source["members"].items()}
        with tarfile.open(fileobj=response, mode="r|zst") as archive:
            for member in archive:
                if member.name in wanted:
                    with (out / wanted.pop(member.name)).open("wb") as f:
                        shutil.copyfileobj(archive.extractfile(member), f)
        if wanted:
            sys.exit(f"{source['url']} lacks {sorted(wanted)}")
for asset, digest in manifest["sha256"].items():
    with (out / asset).open("rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if actual != digest:
        sys.exit(f"{asset}: sha256 {actual}, expected {digest}")
    print(f"{asset} {actual}")
