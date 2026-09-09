#!/usr/bin/env bash
# ============================================================================
# ViewLBA Server — constructor del AppImage (Linux)
# ============================================================================
# Entrada:  dist/release/linux/ViewLBA-Server/ (payload de bundle-server.ts)
# Salida:   dist/release/ViewLBA-Server.AppImage (+ .zsync opcional)
#
# El AppImage contiene: sidecar CLI (installer completo), payload offline
# (servidor+deps+build+runtime bun) y —si se construyó con Tauri (CI)— la GUI
# (viewlba-server-gui). En headless o con --cli arranca el CLI interactivo.
#
# Dependencias de EMPAQUETADO (no del usuario final): appimagetool
# (se descarga si falta), mksquashfs (incluido en appimagetool), wget/curl.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="${1:-$ROOT/dist/release/linux/ViewLBA-Server}"
OUT_DIR="$(dirname "$STAGE")"
APP_NAME="ViewLBA-Server"
APP_DIR="$OUT_DIR/$APP_NAME-CLI.AppDir"
VERSION="$(grep -o '"version": *"[^"]*"' "$STAGE/resources/server/package.json" | head -1 | sed 's/.*"version": *"//;s/"//')"
: "${VERSION:=1.0.0}"

say()  { echo -e "\033[32m✓\033[0m $*"; }
step() { echo -e "\n\033[1m→\033[0m $*"; }
die()  { echo -e "\033[31m✗\033[0m $*" >&2; exit 1; }

[[ -f "$STAGE/viewlba-installer" ]] || die "falta $STAGE/viewlba-installer (ejecuta bundle-server.ts antes)"

# ---------------------------------------------------------------- AppDir
step "Ensamblando AppDir"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/resources" "$APP_DIR/runtime"
cp "$STAGE/viewlba-installer" "$APP_DIR/"
cp -a "$STAGE/resources/server" "$APP_DIR/resources/server"
cp -a "$STAGE/runtime/." "$APP_DIR/runtime/"
[[ -f "$STAGE/manifest.json" ]] && cp "$STAGE/manifest.json" "$APP_DIR/"

# GUI (Tauri): presente cuando la CI construyó el binario de la GUI.
if [[ -f "$STAGE/viewlba-server-gui" ]]; then
  cp "$STAGE/viewlba-server-gui" "$APP_DIR/"
  say "GUI incluida (viewlba-server-gui)"
else
  say "sin GUI (headless/CLI): añádela construyendo Tauri en CI"
fi

# ---------------------------------------------------------------- ícono + desktop
step "Ícono y .desktop"
cp "$ROOT/installer/gui/src-tauri/icons/icon.png" "$APP_DIR/$APP_NAME.png"
cat > "$APP_DIR/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ViewLBA Server
GenericName=Instalador y gestor del servidor ViewLBA
Comment=Señalización digital para restaurantes — installer oficial 100% LAN
Exec=ViewLBA-Server
Icon=ViewLBA-Server
Terminal=true
Categories=System;
StartupNotify=true
EOF
say "desktop entry listo"

# ---------------------------------------------------------------- AppRun
step "AppRun (GUI si hay display; CLI en headless o --cli)"
cat > "$APP_DIR/AppRun" <<'EOF'
#!/usr/bin/env bash
# ViewLBA Server — AppRun: elige GUI (Tauri) o CLI según el entorno.
HERE="$(dirname "$(readlink -f "$0")")"
export VIEWLBA_INSTALLER_BIN="$HERE/viewlba-installer"
# Elección:
#  · --cli siempre CLI
#  · sin display (headless) → CLI
#  · sin binario GUI (paquete CLI) → CLI
#  · resto → GUI (que internamente coordina el mismo sidecar)
if [[ "${1:-}" == "--cli" || -z "${DISPLAY}${WAYLAND_DISPLAY}" || ! -x "$HERE/viewlba-server-gui" ]]; then
  exec "$HERE/viewlba-installer" "$@"
fi
exec "$HERE/viewlba-server-gui" "$@"
EOF
chmod +x "$APP_DIR/AppRun"
say "AppRun listo"

# ---------------------------------------------------------------- appimagetool
step "appimagetool"
TOOL="$OUT_DIR/.appimagetool-x86_64.AppImage"
if [[ ! -x "$TOOL" ]]; then
  curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" \
    || die "no se pudo descargar appimagetool (red de empaquetado)"
  chmod +x "$TOOL"
fi
# Contenedores sin FUSE: extraer y ejecutar.
export APPIMAGE_EXTRACT_AND_RUN=1
export ARCH="${ARCH:-x86_64}"

step "Comprimiendo AppImage (mksquashfs — puede tardar)"
CLI_IMAGE="$OUT_DIR/ViewLBA-Server-CLI.AppImage"
rm -f "$CLI_IMAGE"
"$TOOL" "$APP_DIR" "$CLI_IMAGE" -n "app.version=$VERSION" || die "appimagetool falló"
rm -rf "$OUT_DIR/.appimagetool-x86_64.AppImage"

step "Checksum"
( cd "$OUT_DIR" && sha256sum ViewLBA-Server-CLI.AppImage > ViewLBA-Server-CLI.AppImage.sha256 )
say "$(ls -lh "$CLI_IMAGE" | awk '{print $5, $9}')"
say "AppImage CLI LISTO: $CLI_IMAGE (la GUI completa ViewLBA-Server.AppImage la construye Tauri en CI)"
