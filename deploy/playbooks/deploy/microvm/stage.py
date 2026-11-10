# Stages the pinned micro-VM assets of one architecture into the output directory.
# Each source is downloaded completely before it is unpacked: unpacking is slower
# than the download, and a connection held open by a slow reader gets cut.
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import tempfile
import urllib.request

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())[sys.argv[3]]
out = pathlib.Path(sys.argv[2])
for source in manifest["sources"]:
    with tempfile.TemporaryFile() as download:
        with urllib.request.urlopen(source["url"], timeout=60) as response:
            shutil.copyfileobj(response, download)
        download.seek(0)
        if "members" not in source:
            with (out / source["asset"]).open("wb") as f:
                shutil.copyfileobj(download, f)
            continue
        wanted = {path: asset for asset, path in source["members"].items()}
        with tarfile.open(fileobj=download, mode="r|zst") as archive:
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
