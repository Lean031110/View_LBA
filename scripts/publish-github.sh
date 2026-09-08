#!/bin/bash
# ============================================================
# ViewLBA — Publicación del repositorio en GitHub
# ============================================================
# Uso:
#   GH_TOKEN=github_pat_XXXXX... bash scripts/publish-github.sh
#
# El PAT (fine-grained) necesita permisos sobre el repositorio:
#   · Contents: Read and write   (push)
#   · Metadata: Read             (obligatorio)
#   · Actions:  Read             (esperar el CI)
#   · Administration: Read/write (solo si el repo hay que crearlo)
#
# El token NUNCA se guarda en el repositorio ni en el remote.
# ============================================================
set -euo pipefail

OWNER="Lean031110"
REPO="Pantalla_Restaurante"
DESCRIPTION="ViewLBA — Plataforma profesional de señalización digital para restaurantes: pantalla TV, panel de administración y servidor de streaming RTMP 100% LAN."
TOPICS='["digital-signage","restaurant","rtmp","obs","streaming","lan","nextjs","tailwindcss","prisma","socket-io","typescript","bun"]'

TOKEN="${GH_TOKEN:?Debes exportar GH_TOKEN=github_pat_… (ver cabecera del script)}"
API="https://api.github.com"
AUTH="Authorization: Bearer $TOKEN"

echo "▸ Verificando credenciales…"
LOGIN=$(curl -sf -H "$AUTH" "$API/user" | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')
echo "  Autenticado como: $LOGIN"
[ "$LOGIN" = "$OWNER" ] || echo "  ⚠ El usuario del token ($LOGIN) no coincide con $OWNER — el push podría fallar."

# ---------- 1) Crear el repositorio si no existe ----------
if curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO" > /dev/null; then
  echo "▸ El repositorio $OWNER/$REPO ya existe."
else
  echo "▸ Creando el repositorio $OWNER/$REPO…"
  curl -sf -H "$AUTH" -X POST "$API/user/repos" \
    -d "{\"name\":\"$REPO\",\"description\":\"$DESCRIPTION\",\"private\":false,\"has_wiki\":false,\"has_projects\":false}" > /dev/null \
    || { echo "✗ No se pudo crear el repositorio (¿permiso Administration?). Créalo manualmente en github.com/new y vuelve a ejecutar."; exit 1; }
fi

# ---------- 2) Metadatos profesionales ----------
echo "▸ Configurando descripción, temas y ajustes…"
curl -sf -H "$AUTH" -X PATCH "$API/repos/$OWNER/$REPO" \
  -d "{\"description\":\"$DESCRIPTION\",\"has_wiki\":false,\"has_projects\":false,\"allow_squash_merge\":true,\"allow_merge_commit\":false,\"allow_rebase_merge\":true}" > /dev/null || true
curl -sf -H "$AUTH" -X PUT "$API/repos/$OWNER/$REPO/topics" -d "{\"names\":$TOPICS}" > /dev/null || true

# ---------- 3) Push de la rama main ----------
echo "▸ Subiendo main…"
if git push "https://$OWNER:$TOKEN@github.com/$OWNER/$REPO.git" main; then
  echo "  Push correcto."
else
  echo "✗ El push falló. Si el repositorio ya tenía historial previo y quieres REEMPLAZARLO por completo:"
  echo "    git push --force https://$OWNER:\$GH_TOKEN@github.com/$OWNER/$REPO.git main"
  exit 1
fi

# ---------- 4) Esperar al CI (GitHub Actions) ----------
echo "▸ Esperando a GitHub Actions (CI)…"
for i in $(seq 1 60); do
  sleep 10
  INFO=$(curl -sf -H "$AUTH" "$API/repos/$OWNER/$REPO/actions/runs?per_page=1" \
    | python3 -c 'import json,sys
runs=json.load(sys.stdin).get("workflow_runs",[])
if not runs: print("none none")
else: print(runs[0]["status"], runs[0]["conclusion"] or "-")' 2>/dev/null || echo "error -")
  STATUS=${INFO%% *}
  CONCLUSION=${INFO##* }
  echo "  [$((i*10))s] estado=$STATUS resultado=$CONCLUSION"
  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo "✓ CI EN VERDE → https://github.com/$OWNER/$REPO/actions"
      exit 0
    else
      echo "✗ CI completó con resultado: $CONCLUSION"
      echo "  Revisa los logs: https://github.com/$OWNER/$REPO/actions"
      exit 1
    fi
  fi
done
echo "⚠ El CI sigue en marcha; revisa https://github.com/$OWNER/$REPO/actions"
