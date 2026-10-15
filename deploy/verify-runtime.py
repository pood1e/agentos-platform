import json
import pathlib
import subprocess
import sys
import uuid

namespace = sys.argv[1] if len(sys.argv) > 1 else "agentos"


def execute(args):
    return subprocess.check_output(args, text=True).strip()


service = json.loads(execute([
    "k3s", "kubectl", "get", "service", "kagent-controller", "-n", namespace, "-o", "json"
]))
endpoint = "http://" + service["spec"]["clusterIP"] + ":8083"
base = ["kagent", "--api-url", endpoint, "--gateway-url", endpoint,
        "-n", namespace, "--user-id", "runtime-check", "--timeout", "60s"]
sandbox = json.loads(execute(base + [
    "sandbox", "create", "runtime-check", "--request-id", str(uuid.uuid4()), "--ttl", "10m", "-o", "json"
]))["id"]
try:
    first = execute(base + ["sandbox", "exec", sandbox, "--", "python3", "-c",
        "import os,pathlib; print('guest kernel:',os.uname().release); "
        "pathlib.Path('/data/workspace/check.txt').write_text('microvm-ok')"])
    execute(base + ["sandbox", "suspend", sandbox])
    execute(base + ["sandbox", "resume", sandbox])
    restored = execute(base + ["sandbox", "exec", sandbox, "--", "python3", "-c",
        "from pathlib import Path; value=Path('/data/workspace/check.txt').read_text(); "
        "assert value=='microvm-ok'; print('restored file:',value)"])
    hypervisors = []
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            devices = [str(fd.readlink()) for fd in (entry / "fd").iterdir()]
            if "/dev/kvm" in devices and "anon_inode:kvm-vm" in devices:
                hypervisors.append(int(entry.name))
        except (OSError, PermissionError):
            continue
    if not hypervisors:
        raise RuntimeError("KVM-backed hypervisor process not found")
    print(json.dumps({"sandbox": sandbox, "execution": first, "restoration": restored,
                      "kvm_processes": hypervisors, "result": "passed"}, ensure_ascii=False))
finally:
    execute(base + ["sandbox", "delete", sandbox])
