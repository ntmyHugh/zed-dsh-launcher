#!/usr/bin/env bash
# zed-status.sh —— 输出远端 Zed/DSH 运行状态（JSON），供 dshz 使用。
set -u
python3 - <<'PY'
import glob
import json
import os
import re
import subprocess


def run(cmd: str) -> str:
    try:
        return subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return ""


def etime(pid: int) -> str:
    return run(f"ps -o etime= -p {pid}").strip()


servers = []
out = run("ps -eo pid=,args= | grep -E 'zed-remote-server[^ ]* +proxy +--identifier' | grep -v 'grep -E'")
for raw in out.splitlines():
    line = raw.strip()
    if not line:
        continue
    match = re.match(r"(\d+)\s+(.*)$", line)
    if not match:
        continue
    pid = int(match.group(1))
    args = match.group(2)
    identifier = args.split("proxy --identifier", 1)[1].strip() if "proxy --identifier" in args else ""
    servers.append({"pid": pid, "identifier": identifier, "etime": etime(pid)})

acp = []
out = run("ps -eo pid=,ppid=,args= | grep -F 'dsh --profile acp' | grep -v grep")
for raw in out.splitlines():
    match = re.match(r"(\d+)\s+(\d+)\s+(.*)$", raw.strip())
    if not match:
        continue
    pid = int(match.group(1))
    cwd = ""
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except Exception:
        pass
    acp.append({"pid": pid, "ppid": int(match.group(2)), "etime": etime(pid), "cwd": cwd})

locks: dict[str, list[int]] = {}
for fd in glob.glob("/proc/[0-9]*/fd/*"):
    try:
        target = os.readlink(fd)
    except Exception:
        continue
    if not target.endswith("/session.lock"):
        continue
    session = os.path.basename(os.path.dirname(target))
    try:
        pid = int(fd.split("/")[2])
    except Exception:
        continue
    locks.setdefault(session, []).append(pid)

entries = []
for session, pids in locks.items():
    title = ""
    cache = os.path.expanduser(f"~/.dsh/storages/session_projcache/sessions/{session}.json")
    if os.path.exists(cache):
        try:
            with open(cache, encoding="utf-8") as handle:
                record = json.load(handle)
            title = (((record.get("record", {}).get("rows", {}) or {}).get("title") or {}).get("val")) or ""
        except Exception:
            title = ""
    cwd = ""
    try:
        cwd = os.readlink(f"/proc/{sorted(set(pids))[0]}/cwd")
    except Exception:
        pass
    entries.append({"session": session, "title": title, "holders": sorted(set(pids)), "cwd": cwd})

print(json.dumps({"servers": servers, "acp": acp, "locks": entries}, ensure_ascii=False))
PY
