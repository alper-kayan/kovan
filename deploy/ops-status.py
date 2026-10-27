#!/usr/bin/env python3
# The production host's own report for the outside monitor: disk, memory, Kovan's containers, the
# newest database backup and the last restore drill, as JSON in /srv/kovan/ops/status.json. The
# server serves it at GET /api/ops/status (OPS_TOKEN); the monitor on the Pi reads it every 5
# minutes and tells the operator's phone what goes wrong. Runs from cron as root (deploy/README.md, "Outside monitor"):
#   */5 * * * * root /usr/bin/python3 /srv/kovan/src/deploy/ops-status.py
import glob
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone

OUT = os.environ.get("KOVAN_OPS_DIR", "/srv/kovan/ops")
BACKUPS = os.environ.get("KOVAN_BACKUP_DIR", "/srv/kovan/backups")
# Only Kovan's: other services on this host aren't ours to watch.
CONTAINERS = ("kovan-prod-", "kovan-demo-")


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def disks():
    out, seen = [], set()
    for mount in ("/", "/srv", "/var/lib/docker", "/var/lib/containerd"):
        if not os.path.exists(mount) or os.stat(mount).st_dev in seen:
            continue
        seen.add(os.stat(mount).st_dev)
        st = os.statvfs(mount)
        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        avail = st.f_bavail * st.f_frsize
        out.append({
            "mount": mount,
            # As df counts it: what is used of what a user could use.
            "usedPct": round(100 * used / (used + avail)) if used + avail else 0,
            "freeGb": round(avail / 1e9, 1),
        })
    return out


def memory():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, value = line.split(":", 1)
            info[key] = int(value.split()[0])
    return {"availablePct": round(100 * info["MemAvailable"] / info["MemTotal"])}


def containers():
    names = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    names = [n for n in names if n.startswith(CONTAINERS)]
    if not names:
        return []
    found = json.loads(subprocess.run(
        ["docker", "inspect", *names], capture_output=True, text=True, check=True,
    ).stdout)
    return [{
        "name": c["Name"].lstrip("/"),
        "state": c["State"]["Status"],
        "health": (c["State"].get("Health") or {}).get("Status"),
        "restarts": c["RestartCount"],
    } for c in found]


def backup():
    files = glob.glob(os.path.join(BACKUPS, "kovan-*.dump.enc"))
    if not files:
        return None
    newest = max(files, key=os.path.getmtime)
    return {"file": os.path.basename(newest), "at": iso(os.path.getmtime(newest))}


def restore():
    # The last restore drill (deploy/restore-drill.sh), as it wrote it.
    try:
        with open(os.path.join(OUT, "restore.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main():
    status = {
        "at": iso(datetime.now(timezone.utc).timestamp()),
        "disks": disks(),
        "memory": memory(),
        "containers": containers(),
        "backup": backup(),
        "restore": restore(),
    }
    os.makedirs(OUT, mode=0o755, exist_ok=True)
    # Written whole and then renamed, so the server never reads half of it.
    fd, tmp = tempfile.mkstemp(dir=OUT, prefix=".status-")
    with os.fdopen(fd, "w") as f:
        json.dump(status, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(OUT, "status.json"))


if __name__ == "__main__":
    main()
