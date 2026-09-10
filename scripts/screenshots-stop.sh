#!/usr/bin/env bash
# screenshots-stop.sh — detiene el stack de capturas y el publicador RTMP.
RUN=/home/z/my-project/scripts/.run
cd "$RUN" 2>/dev/null || exit 0
for f in *.pid; do
  [ -f "$f" ] || continue
  kill "$(cat "$f")" 2>/dev/null || true
done
pkill -f "standalone/server.js" 2>/dev/null || true
pkill -f "mini-services/realtime-service/index.ts" 2>/dev/null || true
pkill -f "mini-services/stream-service/index.ts" 2>/dev/null || true
pkill -f "rtmp://127.0.0.1:1935" 2>/dev/null || true
echo "✓ stack de capturas detenido"
