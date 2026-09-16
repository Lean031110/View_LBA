#!/usr/bin/env python3
"""Monitor puntual de las GitHub Actions de ViewLBA (una consulta, sin bucle)."""
import json
import sys
import urllib.request

TOKEN = sys.argv[1]
RUN_ID = sys.argv[2]
API = "https://api.github.com/repos/Lean031110/View_LBA"

def get(url: str):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "monitor"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

run = get(f"{API}/actions/runs/{RUN_ID}")
print(f"RUN {run['id']} [{run['name']}] sha={run['head_sha'][:7]} status={run['status']} conclusion={run['conclusion']}")
jobs = get(f"{API}/actions/runs/{RUN_ID}/jobs?per_page=20").get("jobs", [])
for j in jobs:
    mark = {"success": "OK", "failure": "FAIL", "cancelled": "SKIP"}.get(j["conclusion"], "…")
    step = ""
    if j["status"] == "in_progress":
        started = [s for s in j.get("steps", []) if s["status"] == "in_progress"]
        step = " → " + started[-1]["name"] if started else " (arrancando)"
    print(f"  [{mark}] {j['name']}: {j['status']}{step}")
    for s in j.get("steps", []):
        if s["conclusion"] == "failure":
            print(f"        ✗ paso: {s['name']}")
