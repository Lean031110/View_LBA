#!/usr/bin/env bash
# screenshots-realtime.sh — (re)arranca SOLO el realtime-service para las
# capturas. Los procesos lanzados desde un script persistido sobreviven a la
# sesión del shell (los inline no).
set -uo pipefail
cd /home/z/my-project
RUN=/home/z/my-project/scripts/.run
pkill -f "mini-services/realtime-service/index.ts" 2>/dev/null || true
sleep 1
export DATABASE_URL=file:/home/z/my-project/db/e2e.db
export AUTH_SECRET=e2e-secret-0123456789abcdef0123456789
export REALTIME_TOKEN=e2e-rt-internal-token-0123456789abcdef
export LOGIN_RATE_LIMIT_IP_MAX=500
nohup bun mini-services/realtime-service/index.ts > "$RUN/realtime.log" 2>&1 &
echo $! > "$RUN/realtime.pid"
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3004/health >/dev/null 2>&1; then
    echo "✓ realtime-service listo (pid $(cat "$RUN/realtime.pid"))"
    exit 0
  fi
  sleep 1
done
echo "✗ realtime no arrancó"; tail -n 10 "$RUN/realtime.log"; exit 1
