#!/bin/bash
# ViewLBA — Supervisor del servicio realtime
# Verifica cada 10s que el servicio responda en 3004; si cayó, lo reinicia.
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT/mini-services/realtime-service"

LOG="$ROOT/realtime-supervisor.log"

while true; do
  if ! curl -s --max-time 2 http://127.0.0.1:3004/status > /dev/null 2>&1; then
    echo "[$(date '+%F %T')] Realtime caído → reiniciando" >> "$LOG"
    (setsid nohup bun index.ts >> "$ROOT/realtime.log" 2>&1 < /dev/null &)
    sleep 5
  fi
  sleep 10
done
