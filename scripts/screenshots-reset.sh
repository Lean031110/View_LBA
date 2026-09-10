#!/usr/bin/env bash
# screenshots-reset.sh — reset COMPLETO del entorno de capturas:
#   1) detiene stack + publicador
#   2) DB e2e fresca (migraciones + seed demo) → log de auditoría limpio
#   3) relanza realtime + stream-service + web (espectadores a 0)
#   4) relanza el publicador RTMP
# Uso: bash scripts/screenshots-reset.sh
set -uo pipefail
cd /home/z/my-project

bash scripts/screenshots-stop.sh
bun scripts/e2e-setup.ts >/dev/null 2>&1 || { echo "✗ e2e-setup falló"; exit 1; }
echo "✓ DB e2e fresca"
bash scripts/screenshots-stack.sh || exit 1
bash scripts/screenshots-stream.sh || exit 1
echo "✅ entorno de capturas reseteado"
