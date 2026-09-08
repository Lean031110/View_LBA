#!/bin/bash
# ViewLBA — Supervisor del servidor de streaming RTMP
# Verifica cada 10s que el control interno responda en 8100; si cayó, lo reinicia.
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT/mini-services/stream-service"

LOG="$ROOT/stream-supervisor.log"

while true; do
  if ! curl -s --max-time 2 http://127.0.0.1:8100/health > /dev/null 2>&1; then
    echo "[$(date '+%F %T')] Stream-service caído → reiniciando" >> "$LOG"
    (setsid nohup bun index.ts >> "$ROOT/stream-service.log" 2>&1 < /dev/null &)
    sleep 5
  fi
  sleep 10
done
