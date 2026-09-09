#!/usr/bin/env bash
# ============================================================================
# Pantalla Restaurante — Instalador de PRODUCCIÓN (Linux/systemd) — FASE 28
# ============================================================================
# Uso (desde un checkout del repo, como root o con sudo):
#   sudo bash deploy/linux/install.sh
#
# Qué hace:
#   1. Verifica dependencias (bun, openssl, curl, rsync)
#   2. Crea usuario de sistema `pantalla` (NO root, sin login)
#   3. Layout estándar:
#        /opt/pantalla-restaurante              → código (read-only p/ el servicio)
#        /var/lib/pantalla-restaurante          → DB, media, datos de NMS
#        /var/log/pantalla-restaurante          → logs estructurados (rotativos)
#        /etc/pantalla-restaurante.env          → entorno+secretos (root:600)
#   4. Genera secretos reales (openssl) si no existían
#   5. Instala deps (root + mini-servicios) · prisma generate · migrate deploy
#   6. Build standalone de producción
#   7. Instala unidades systemd (app/realtime/stream + timers) y arranca
#   8. Espera health real (/api/health) y muestra el estado
#
# Idempotente: re-ejecutar actualiza código/unidades sin borrar datos.
# Para ACTUALIZAR una instalación existente: deploy/linux/manage.sh upgrade
# ============================================================================
set -euo pipefail

APP_NAME="pantalla-restaurante"
APP_DIR="/opt/pantalla-restaurante"
DATA_DIR="/var/lib/pantalla-restaurante"
LOG_DIR="/var/log/pantalla-restaurante"
ENV_FILE="/etc/pantalla-restaurante.env"
SERVICE_USER="pantalla"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
say()  { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta como root: sudo bash deploy/linux/install.sh"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$SRC_DIR/package.json" ]] || die "No encuentro el repositorio (ejecuta desde el checkout)"

# ---------------------------------------------------------------- 1. deps
BUN_BIN="$(command -v bun || true)"
[[ -n "$BUN_BIN" ]] || die "bun no está instalado. Instálalo: curl -fsSL https://bun.sh/install | bash (y reabre sesión)"
for dep in openssl curl rsync systemctl; do
  command -v "$dep" >/dev/null 2>&1 || die "Falta '$dep' (requerido)"
done
say "Dependencias OK (bun: $BUN_BIN)"

# ---------------------------------------------------------------- 2. usuario
if id "$SERVICE_USER" &>/dev/null; then
  say "Usuario '$SERVICE_USER' ya existe"
else
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  say "Usuario de sistema '$SERVICE_USER' creado (sin login, sin root)"
fi

# ---------------------------------------------------------------- 3. layout
mkdir -p "$APP_DIR" "$DATA_DIR/db" "$DATA_DIR/media" "$DATA_DIR/backups" "$DATA_DIR/data" "$LOG_DIR"
chmod 750 "$DATA_DIR" "$LOG_DIR"

# ---------------------------------------------------------------- 4. entorno
if [[ -f "$ENV_FILE" ]]; then
  warn "Entorno existente: $ENV_FILE (se conservan secretos y rutas)"
else
  AUTH_SECRET="$(openssl rand -hex 24)"
  REALTIME_TOKEN="$(openssl rand -hex 16)"
  cat > "$ENV_FILE" <<EOF
# Pantalla Restaurante — entorno de producción (root:600, JAMÁS al repo)
# Generado por install.sh el $(date -Is)

# --- Obligatorias ---
AUTH_SECRET=$AUTH_SECRET
REALTIME_TOKEN=$REALTIME_TOKEN
DATABASE_URL=file:$DATA_DIR/db/custom.db

# --- App ---
PORT=3000
NODE_ENV=production
TIMEZONE=America/Havana

# --- Almacenamiento separado (FASE 11) ---
MEDIA_DIR=$DATA_DIR/media
BACKUP_DIR=$DATA_DIR/backups
LOG_DIR=$LOG_DIR
DATA_DIR=$DATA_DIR/data

# --- Seguridad ---
# LOGIN_RATE_LIMIT_IP_MAX=12
# LOG_RETENTION_DAYS=90

# --- Streaming (defaults) ---
# RTMP_PORT=1935
# HTTP_FLV_PORT=8000
EOF
  say "Secretos generados (openssl) en $ENV_FILE"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- 5. código
say "Sincronizando código → $APP_DIR (sin datos ni dependencias)"
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude db --exclude upload --exclude uploads --exclude logs \
  --exclude backups --exclude data --exclude test-results \
  --exclude playwright-report --exclude dev.log --exclude server.log \
  "$SRC_DIR"/ "$APP_DIR"/
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

run_as() { sudo -u "$SERVICE_USER" -H bash -lc "$*"; }

say "Instalando dependencias (root + mini-servicios)"
run_as "cd $APP_DIR && bun install --frozen-lockfile"
run_as "cd $APP_DIR/mini-services/realtime-service && bun install --frozen-lockfile"
run_as "cd $APP_DIR/mini-services/stream-service && bun install --frozen-lockfile"

say "Generando Prisma Client"
run_as "cd $APP_DIR && bunx prisma generate"

say "Aplicando migraciones versionadas (migrate deploy — JAMÁS db push)"
run_as "cd $APP_DIR && set -a && source $ENV_FILE && set +a && bunx prisma migrate deploy"

# ---------------------------------------------------------------- 6. build
say "Build de producción (standalone)"
run_as "cd $APP_DIR && set -a && source $ENV_FILE && set +a && bun run build"

# ---------------------------------------------------------------- 7. systemd
say "Instalando unidades systemd (sustituyendo __BUN_BIN__)"
for unit in pantalla-restaurante.service pantalla-restaurante-realtime.service \
            pantalla-restaurante-stream.service pantalla-restaurante.target \
            pantalla-restaurante-backup.service pantalla-restaurante-backup.timer \
            pantalla-restaurante-logs-purge.service pantalla-restaurante-logs-purge.timer; do
  sed "s|__BUN_BIN__|$BUN_BIN|g" "$APP_DIR/deploy/linux/$unit" > "/etc/systemd/system/$unit"
done
chown "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" -R
chmod 750 "$DATA_DIR" "$LOG_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$LOG_DIR"
systemctl daemon-reload
systemctl enable "$APP_NAME.target" "$APP_NAME-backup.timer" "$APP_NAME-logs-purge.timer" >/dev/null 2>&1
say "Servicios habilitados (arranque automático del equipo + timers)"

systemctl restart "$APP_NAME.target"
systemctl restart "$APP_NAME-backup.timer" "$APP_NAME-logs-purge.timer" 2>/dev/null || true

# ---------------------------------------------------------------- 8. health
PORT_FROM_ENV="$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 || true)"
APP_PORT="${PORT_FROM_ENV:-3000}"
say "Esperando health real (http://127.0.0.1:$APP_PORT/api/health)…"
ok=""
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [[ -z "$ok" ]]; then
  warn "La app no respondió health en 120s — revisa: journalctl -u $APP_NAME -n 50"
  systemctl --no-pager --lines 5 status "$APP_NAME.service" || true
else
  say "Health OK — plataforma operativa"
fi

echo
echo -e "${BOLD}=== INSTALACIÓN COMPLETA ===${NC}"
systemctl --no-pager is-active "$APP_NAME.service" "$APP_NAME-realtime.service" "$APP_NAME-stream.service" || true
echo
echo "Primer administrador (solo la primera vez):"
echo "  sudo -u $SERVICE_USER -H bash -lc 'cd $APP_DIR && set -a && source $ENV_FILE && set +a && bun scripts/init-production.ts'"
echo
echo "Gestión diaria:    bash $APP_DIR/deploy/linux/manage.sh {start|stop|restart|status|logs|backup|restore|health}"
echo "Documentación:     $APP_DIR/docs/OPERATIONS.md"
