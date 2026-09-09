#!/usr/bin/env python3
"""Monitor de las GitHub Actions de ViewLBA hasta el Release con artefactos."""
import json
import sys
import time
import urllib.request

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
RUN_ID = sys.argv[2] if len(sys.argv) > 2 else ""
API = "https://api.github.com/repos/Lean031110/Pantalla_Restaurante"

def get(url: str):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "monitor"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def show_run(run):
    print(f"RUN {run['id']} [{run['name']}] event={run['event']} status={run['status']} conclusion={run['conclusion']}")

def show_jobs(run_id):
    jobs = get(f"{API}/actions/runs/{run_id}/jobs?per_page=20").get("jobs", [])
    for j in jobs:
        mark = {"success": "✓", "failure": "✗", "cancelled": "⊘"}.get(j["conclusion"], "…")
        cur = j["step"]  # None until started
        step = ""
        if j["status"] == "in_progress" and cur is None:
            # current step: last started not completed
            started = [s for s in j.get("steps", []) if s["status"] in ("in_progress",)]
            step = " → " + started[-1]["name"] if started else ""
        print(f"  {mark} {j['name']}: {j['status']}/{j['conclusion']}{step}")
        for s in j.get("steps", []):
            if s["conclusion"] == "failure":
                print(f"      ✗ paso: {s['name']}")
    return jobs

if __name__ == "__main__":
    while True:
        try:
            run = get(f"{API}/actions/runs/{RUN_ID}")
            show_run(run)
            jobs = show_jobs(RUN_ID)
            if run["status"] == "completed":
                print(f"FINAL: {run['conclusion']}")
                break
            print("---")
        except Exception as e:
            print(f"(error de red: {e}) — reintento")
        time.sleep(45)
