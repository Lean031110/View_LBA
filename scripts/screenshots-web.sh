#!/usr/bin/env bash
# screenshots-web.sh — (re)arranca SOLO la web (standalone) para las capturas
# o para tests de integración contra el build. Sin mini-servicios: así el
# /api/health reporta "degraded" como espera el job de integración de CI.
set -uo pipefail
cd /home/z/my-project
RUN=/home/z/my-project/scripts/.run
pkill -f "standalone/server.js" 2>/dev/null || true
sleep 1
export DATABASE_URL=file:/home/z/my-project/db/e2e.db
export AUTH_SECRET=e2e-secret-0123456789abcdef0123456789
export REALTIME_TOKEN=e2e-rt-internal-token-0123456789abcdef
export LOGIN_RATE_LIMIT_IP_MAX=500
export NODE_ENV=production
PORT=3000 nohup bun scripts/start.ts > "$RUN/web.log" 2>&1 &
echo $! > "$RUN/web.pid"
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "✓ web lista (pid $(cat "$RUN/web.pid")) — sin mini-servicios"
    exit 0
  fi
  sleep 2
done
echo "✗ web no arrancó"; tail -n 10 "$RUN/web.log"; exit 1
