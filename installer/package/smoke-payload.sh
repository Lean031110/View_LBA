#!/usr/bin/env bash
# ============================================================================
# ViewLBA Server — SMOKE TEST REAL del payload de producción
# ============================================================================
# Arranca el servidor de producción DESDE EL PAYLOAD (no desde el repo):
#   1. prisma migrate deploy con el node_modules PODADO (cero red)
#   2. seed de verificación (PrismaClient del payload)
#   3. arranque: runtime/bun + scripts/start.ts → .next/standalone/server.js
#   4. GET /api/health → 200 + JSON (database/storage) + GET / → 200
#   5. mini-services: realtime + stream arrancan y sobreviven 3s
#   6. SIGTERM: parada limpia (systemd/NSSM dependen de esto)
#
# USO: installer/package/smoke-payload.sh <staging>   (p.ej. dist/release/linux/ViewLBA-Server)
# Dependencias: curl. Exit 0 = payload ejecutable; cualquier fallo = exit 1.
# ============================================================================
set -euo pipefail

STAGE="${1:-dist/release/linux/ViewLBA-Server}"
STAGE="$(cd "$STAGE" && pwd)" # rutas absolutas: el script hace cd() durante el test
BUN="$STAGE/runtime/bun"
BUNX="$STAGE/runtime/bunx"
SERVER="$STAGE/resources/server"
PORT="${SMOKE_PORT:-3999}"
RT_PORT="${SMOKE_REALTIME_PORT:-4001}"
DB="$(mktemp -t viewlba-smoke-XXXXXX).db"
LOG="$(mktemp -t viewlba-smoke-XXXXXX.log)"

export DATABASE_URL="file:$DB"
export AUTH_SECRET="smoke-test-secret-0123456789-not-real"
export REALTIME_TOKEN="smoke-test-token-0123456789-not-real"
export NODE_ENV="production"
export PORT

pass() { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }
trap '[[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true' EXIT

[[ -x "$BUN" ]]  || fail "no hay runtime/bun ejecutable en $STAGE"
[[ -f "$SERVER/.next/standalone/server.js" ]] || fail "falta .next/standalone/server.js (entrypoint)"
[[ -f "$SERVER/node_modules/@prisma/client/default.js" ]] || fail "falta @prisma/client en el payload"
[[ -d "$SERVER/node_modules/@prisma/engines" ]] || fail "falta @prisma/engines en el payload"
pass "estructura: entrypoint + prisma client + engines"

# ---------------------------------------------------------------- 1. migración
echo "→ migrate deploy desde el PAYLOAD (node_modules podado, cero red)"
( cd "$SERVER" && "$BUNX" prisma migrate deploy ) > /tmp/viewlba-smoke-migrate.log 2>&1 \
  || { cat /tmp/viewlba-smoke-migrate.log; fail "migrate deploy falló — el payload no puede migrar offline"; }
grep -q "applied" /tmp/viewlba-smoke-migrate.log && pass "migraciones aplicadas: $(grep -c 'applied' /tmp/viewlba-smoke-migrate.log) entrada(s))" \
  || pass "migrate deploy OK (sin migraciones nuevas)"
[[ -f "$DB" ]] || fail "la BD no existe tras migrate deploy"

# ---------------------------------------------------------------- 2. seed
echo "→ seed desde el PAYLOAD (PrismaClient del node_modules podado)"
( cd "$SERVER" && "$BUN" prisma/seed.ts ) > /tmp/viewlba-smoke-seed.log 2>&1 \
  || { tail -5 /tmp/viewlba-smoke-seed.log; fail "seed falló — PrismaClient no funciona desde el payload"; }
pass "seed OK (admin/demo si aplica)"

# ---------------------------------------------------------------- 3. arranque
echo "→ arrancando producción: runtime/bun scripts/start.ts (PORT=$PORT)"
( cd "$SERVER" && "$BUN" scripts/start.ts ) > "$LOG" 2>&1 &
SERVER_PID=$!

HEALTH=""
for i in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "--- server.log ---"; tail -20 "$LOG"; fail "el servidor murió durante el arranque"
  fi
  CODE=$(curl -s -o /tmp/viewlba-smoke-health.json -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 000)
  if [[ "$CODE" == "200" ]]; then HEALTH=$(cat /tmp/viewlba-smoke-health.json); break; fi
  sleep 1
done
[[ -n "$HEALTH" ]] || { echo "--- server.log ---"; tail -20 "$LOG"; fail "health check sin 200 en 30s"; }
# semántica REAL de /api/health: database ok + storage writable; "degraded"
# sin mini-services es el estado correcto de un arranque aislado (documentado)
echo "$HEALTH" | grep -q '"database":{"ok":true' || fail "/api/health sin database ok → $HEALTH"
echo "$HEALTH" | grep -q '"storage":{"ok":true'  || fail "/api/health sin storage ok → $HEALTH"
pass "GET /api/health → 200 $(echo "$HEALTH" | head -c 140)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" || echo 000)
[[ "$CODE" == "200" ]] || fail "GET / devolvió $CODE"
pass "GET / → 200 (UI servida desde el standalone)"

# ---------------------------------------------------------------- 4. mini-services
echo "→ mini-services desde el PAYLOAD (realtime + stream)"
( cd "$SERVER/mini-services/realtime-service" && PORT_REALTIME=$RT_PORT REALTIME_TOKEN="$REALTIME_TOKEN" AUTH_SECRET="$AUTH_SECRET" "$BUN" index.ts ) > /tmp/viewlba-smoke-rt.log 2>&1 &
RT_PID=$!
sleep 3
kill -0 "$RT_PID" 2>/dev/null || { tail -5 /tmp/viewlba-smoke-rt.log; fail "realtime-service murió al arrancar"; }
pass "realtime-service vivo (pid $RT_PID, puerto $RT_PORT)"
kill "$RT_PID" 2>/dev/null || true

( cd "$SERVER/mini-services/stream-service" && "$BUN" index.ts ) > /tmp/viewlba-smoke-st.log 2>&1 &
ST_PID=$!
sleep 3
kill -0 "$ST_PID" 2>/dev/null || { tail -5 /tmp/viewlba-smoke-st.log; fail "stream-service murió al arrancar"; }
pass "stream-service vivo (pid $ST_PID)"
kill "$ST_PID" 2>/dev/null || true

# ---------------------------------------------------------------- 5. parada
echo "→ SIGTERM al servidor (parada limpia)"
kill "$SERVER_PID" 2>/dev/null || true
for i in $(seq 1 10); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill -9 "$SERVER_PID" 2>/dev/null || true
  fail "el servidor no respondió a SIGTERM en 10s (systemd lo mataría a la fuerza)"
fi
pass "parada limpia con SIGTERM"
SERVER_PID=""

rm -f "$DB" "$LOG" /tmp/viewlba-smoke-*.log /tmp/viewlba-smoke-health.json
echo ""
echo "✓ SMOKE TEST DEL PAYLOAD COMPLETO: el staging ES ejecutable en producción"
