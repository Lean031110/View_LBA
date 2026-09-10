#!/usr/bin/env bash
# screenshots-stack.sh — levanta el stack real para las capturas del README.
# DB aislada db/e2e.db (la misma del E2E). NO toca db/custom.db.
set -uo pipefail
cd /home/z/my-project
export DATABASE_URL=file:/home/z/my-project/db/e2e.db
export AUTH_SECRET=e2e-secret-0123456789abcdef0123456789
export REALTIME_TOKEN=e2e-rt-internal-token-0123456789abcdef
export LOGIN_RATE_LIMIT_IP_MAX=500
RUN=/home/z/my-project/scripts/.run
mkdir -p "$RUN"

nohup bun mini-services/realtime-service/index.ts  > "$RUN/realtime.log" 2>&1 &
echo $! > "$RUN/realtime.pid"
nohup bun mini-services/stream-service/index.ts    > "$RUN/stream.log"   2>&1 &
echo $! > "$RUN/stream.pid"
PORT=3000 NODE_ENV=production nohup bun scripts/start.ts > "$RUN/web.log" 2>&1 &
echo $! > "$RUN/web.pid"

for i in $(seq 1 60); do
  ok=1
  curl -sf http://127.0.0.1:3004/health >/dev/null 2>&1 || ok=0
  curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1 || ok=0
  curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1 || ok=0
  if [ "$ok" = "1" ]; then echo "✓ stack listo (intento $i)"; exit 0; fi
  sleep 2
done
echo "✗ el stack no arrancó"
tail -n 8 "$RUN"/*.log
exit 1
