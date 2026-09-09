#!/usr/bin/env bash
# ============================================================================
# Pantalla Restaurante — Gestión de la instalación (FASE 28)
# ============================================================================
# Uso:  bash deploy/linux/manage.sh <comando>
#   start     — arranca todos los servicios
#   stop      — detiene todos (orden inverso: app → realtime → stream)
#   restart   — reinicia (por servicio: manage.sh restart [app|realtime|stream])
#   status    — estado + health real + timers
#   logs      — sigue los logs de los tres servicios (journalctl -f)
#   health    — solo el estado de salud (/api/health + mini-servicios)
#   backup    — backup manual YA (verificado, online)
#   restore   — restore desde un archivo: manage.sh restore <archivo.db>
#   upgrade   — actualiza código desde el checkout de origen + migra + build + reinicia
# ============================================================================
set -euo pipefail

APP_NAME="pantalla-restaurante"
APP_DIR="/opt/pantalla-restaurante"
ENV_FILE="/etc/pantalla-restaurante.env"
SERVICE_USER="pantalla"
MANAGE="$APP_DIR/deploy/linux/manage.sh"

[[ $EUID -eq 0 ]] || { echo "Ejecuta con sudo"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "No hay instalación en $APP_DIR (¿install.sh?)"; exit 1; }

APP_PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 || echo 3000)"
HEALTH_URL="http://127.0.0.1:${APP_PORT:-3000}/api/health"

run_as() { sudo -u "$SERVICE_USER" -H bash -lc "$*"; }

svc() { systemctl "$@" "$APP_NAME.service" "$APP_NAME-realtime.service" "$APP_NAME-stream.service"; }

cmd="${1:-help}"

case "$cmd" in
  start)
    echo "→ Arrancando plataforma…"
    systemctl start "$APP_NAME-stream.service" "$APP_NAME-realtime.service" "$APP_NAME.service"
    sleep 3
    exec bash "$MANAGE" health
    ;;

  stop)
    echo "→ Deteniendo plataforma (app → realtime → stream)…"
    systemctl stop "$APP_NAME.service" "$APP_NAME-realtime.service" "$APP_NAME-stream.service"
    echo "✓ Detenida"
    ;;

  restart)
    target="${2:-all}"
    case "$target" in
      app)      systemctl restart "$APP_NAME.service" ;;
      realtime) systemctl restart "$APP_NAME-realtime.service" ;;
      stream)   systemctl restart "$APP_NAME-stream.service" ;;
      all)      systemctl restart "$APP_NAME-stream.service" "$APP_NAME-realtime.service" "$APP_NAME.service" ;;
      *) echo "Uso: restart [app|realtime|stream|all]"; exit 1 ;;
    esac
    sleep 3
    exec bash "$MANAGE" health
    ;;

  status)
    echo "=== Servicios ==="
    systemctl --no-pager --lines 3 status "$APP_NAME.service" "$APP_NAME-realtime.service" "$APP_NAME-stream.service" || true
    echo
    echo "=== Timers ==="
    systemctl --no-pager list-timers "$APP_NAME-backup.timer" "$APP_NAME-logs-purge.timer" --all || true
    echo
    exec bash "$MANAGE" health
    ;;

  logs)
    echo "→ journalctl -f (Ctrl+C para salir) — los tres servicios:"
    exec journalctl -f -t pantalla-restaurante -t pantalla-realtime -t pantalla-stream
    ;;

  health)
    echo "=== /api/health (app) ==="
    if out="$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
      echo "$out" | (python3 -m json.tool 2>/dev/null || cat)
    else
      echo "✗ La app no responde en $HEALTH_URL"
    fi
    echo
    echo "=== Mini-servicios (health interno) ==="
    for svc_port in "realtime:3004" "stream:8100"; do
      name="${svc_port%%:*}"; port="${svc_port##*:}"
      if curl -sf --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
        echo "✓ $name (:$port) operativo"
      else
        echo "✗ $name (:$port) CAÍDO"
      fi
    done
    ;;

  backup)
    echo "→ Backup manual (online, verificado)…"
    run_as "cd $APP_DIR && set -a && source $ENV_FILE && set +a && bun scripts/backup.ts"
    ;;

  restore)
    file="${2:-}"
    [[ -n "$file" && -f "$file" ]] || { echo "Uso: restore <ruta/al/backup.db>"; exit 1; }
    file_abs="$(readlink -f "$file")"
    echo "→ Restaurando $file_abs (detiene servicios, restaura, verifica, arranca)"
    run_as "cd $APP_DIR && set -a && source $ENV_FILE && set +a && bun scripts/restore.ts '$file_abs'"
    echo "→ Reiniciando servicios…"
    systemctl restart "$APP_NAME-stream.service" "$APP_NAME-realtime.service" "$APP_NAME.service"
    sleep 3
    exec bash "$MANAGE" health
    ;;

  upgrade)
    SRC_DIR="${2:-$(cd "$APP_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || echo "")}"
    [[ -n "$SRC_DIR" && -f "$SRC_DIR/package.json" ]] || {
      echo "Uso: upgrade <ruta/al/checkout-actualizado>"
      echo "  (el checkout debe tener el código NUEVO: git pull allí primero)"
      exit 1
    }
    echo "→ Actualizando desde $SRC_DIR (los DATOS no se tocan)"
    bash "$SRC_DIR/deploy/linux/install.sh"
    ;;

  *)
    grep -E "^#   " "$0" | sed 's/^#   //'
    ;;
esac
