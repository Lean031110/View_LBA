#!/usr/bin/env bash
# ============================================================================
# ViewLBA Server — constructor del AppImage de la GUI (Linux)
# ============================================================================
# Entrada:  $1 = staging de bundle-server.ts (dist/release/linux/ViewLBA-Server)
#           $2 = binario GUI de Tauri (target/release/viewlba-installer-gui)
#           $3 = versión (para el nombre del artefacto)
# Salida:   dist/release/linux/out/ViewLBA-Server-<version>-x86_64.AppImage
#
# POR QUÉ ESTE SCRIPT (en vez de `cargo tauri build --bundles appimage`):
# tauri-bundler coloca el sidecar (externalBin) en AppDir/usr/bin y linuxdeploy
# ejecuta `ldd` sobre TODO ELF de usr/bin para trazar dependencias: los binarios
# standalone de bun (`bun build --compile`) rompen ese escaneo con "Failed to
# run ldd: exited with code 1" (reproducido localmente — ver worklog). El mismo
# sidecar en usr/lib/<producto>/bin/ SÍ pasa el escaneo.
#
# Layout del AppDir (contrato con la GUI):
#   usr/bin/viewlba-installer-gui                    ← binario Tauri (ELF normal)
#   usr/lib/viewlba-server/bin/viewlba-installer     ← sidecar (FUERA de usr/bin)
#   usr/lib/viewlba-server/resources/{server,runtime}/ + manifest.json
#   AppRun: VIEWLBA_INSTALLER_BIN + VIEWLBA_PAYLOAD_DIR → la GUI los honra
#           (sidecar_command/payload_dir en lib.rs los leen PRIMERO).
#
# linuxdeploy directo (con plugins gtk+gstreamer de las MISMAS URLs que
# tauri-bundler) agrupa las libs de webkit2gtk → AppImage portable.
# Dependencias de EMPAQUETADO (no del usuario): curl, linuxdeploy+plugins
# (se descargan), gtk/gstreamer tools en el runner (instalados por el workflow).
# ============================================================================
set -euo pipefail

STAGE="${1:?uso: appimage-gui.sh <staging> <gui-binary> <version>}"
GUI_BIN="${2:?falta el binario GUI (target/release/viewlba-installer-gui)}"
VERSION="${3:?falta la versión}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/dist/release/linux/out"
APP_NAME="viewlba-server"
APP_DIR="$ROOT/dist/release/.gui-AppDir"
IMG_OUT="$OUT_DIR/ViewLBA-Server-$VERSION-x86_64.AppImage"

say()  { echo -e "\033[32m✓\033[0m $*"; }
step() { echo -e "\n\033[1m→\033[0m $*"; }
die()  { echo -e "\033[31m✗\033[0m $*" >&2; exit 1; }

[[ -x "$GUI_BIN" ]] || die "no hay binario GUI ejecutable: $GUI_BIN"
[[ -d "$STAGE/resources/server" ]] || die "staging inválido: $STAGE"
[[ -f "$STAGE/manifest.json" ]] || die "falta manifest.json en el staging"

# ---------------------------------------------------------------- AppDir
step "Ensamblando AppDir (GUI + sidecar FUERA de usr/bin + payload)"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/usr/bin" "$APP_DIR/usr/lib/$APP_NAME/bin" "$APP_DIR/usr/lib/$APP_NAME/resources"
cp "$GUI_BIN" "$APP_DIR/usr/bin/viewlba-installer-gui"
# sidecar + payload en usr/lib (linuxdeploy NO muere con ldd aquí — repro local)
cp "$STAGE/viewlba-installer" "$APP_DIR/usr/lib/$APP_NAME/bin/viewlba-installer"
chmod +x "$APP_DIR/usr/lib/$APP_NAME/bin/viewlba-installer"
cp -a "$STAGE/resources/server" "$APP_DIR/usr/lib/$APP_NAME/resources/server"
cp -a "$STAGE/runtime" "$APP_DIR/usr/lib/$APP_NAME/resources/runtime"
cp "$STAGE/manifest.json" "$APP_DIR/usr/lib/$APP_NAME/resources/"
say "AppDir listo: GUI + sidecar + payload + runtime"

# ---------------------------------------------------------------- icon + desktop
step "Ícono y .desktop"
cp "$ROOT/installer/gui/src-tauri/icons/icon.png" "$APP_DIR/$APP_NAME.png"
cat > "$APP_DIR/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ViewLBA Server
GenericName=Instalador y gestor del servidor ViewLBA
Comment=Señalización digital para restaurantes — installer oficial 100% LAN
Exec=viewlba-installer-gui
Icon=$APP_NAME
Terminal=false
Categories=System;
StartupNotify=true
EOF
say "desktop entry listo"

# ---------------------------------------------------------------- AppRun
step "AppRun (env → la GUI resuelve sidecar/payload por variables)"
cat > "$APP_DIR/AppRun" <<'EOF'
#!/bin/sh
# ViewLBA Server (GUI) — AppRun
# VIEWLBA_INSTALLER_BIN: sidecar_command() la lee ANTES que el escaneo del exe.
# VIEWLBA_PAYLOAD_DIR:   payload_dir() la lee para el CLI embebido.
HERE="$(dirname "$(readlink -f "$0")")"
export VIEWLBA_INSTALLER_BIN="$HERE/usr/lib/viewlba-server/bin/viewlba-installer"
export VIEWLBA_PAYLOAD_DIR="$HERE/usr/lib/viewlba-server/resources"
exec "$HERE/usr/bin/viewlba-installer-gui" "$@"
EOF
chmod +x "$APP_DIR/AppRun"
say "AppRun listo"

# ---------------------------------------------------------------- linuxdeploy
step "linuxdeploy (mismas URLs que tauri-bundler) + plugins gtk/gstreamer"
TOOLS="$ROOT/dist/release/.linuxdeploy-tools"
mkdir -p "$TOOLS"
dl() { [[ -s "$TOOLS/$2" ]] || curl -fsSL -o "$TOOLS/$2" "$1" || die "descarga falló: $2"; chmod +x "$TOOLS/$2"; }
dl "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage" "linuxdeploy"
dl "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh" "linuxdeploy-plugin-gtk.sh"
dl "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh" "linuxdeploy-plugin-gstreamer.sh"
dl "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage" "linuxdeploy-plugin-appimage"
# plugins al lado de linuxdeploy + en PATH (descubrimiento: dir del binario + PATH)
export PATH="$TOOLS:$PATH"
export APPIMAGE_EXTRACT_AND_RUN=1
export OUTPUT="$IMG_OUT"   # plugin-appimage escribe EXACTAMENTE aquí
export ARCH="${ARCH:-x86_64}"
export NO_STRIP=1
# Plugins externos (gtk/gstreamer agrupan las libs de webkit). En entornos sin
# gtk-tools (p.ej. sandbox de desarrollo) se puede probar sin plugins:
# APPIMAGE_GUI_PLUGINS=none bash installer/package/appimage-gui.sh …
if [[ "${APPIMAGE_GUI_PLUGINS:-default}" == "default" ]]; then
  PLUGINS="--plugin gtk --plugin gstreamer"
elif [[ -z "${APPIMAGE_GUI_PLUGINS}" || "${APPIMAGE_GUI_PLUGINS}" == "none" ]]; then
  PLUGINS=""
else
  PLUGINS="${APPIMAGE_GUI_PLUGINS}"
fi

step "Empaquetando AppImage GUI (linuxdeploy + plugins — puede tardar)"
mkdir -p "$OUT_DIR"   # mksquashfs escribe $OUTPUT aquí (falla si el dir no existe)
rm -f "$IMG_OUT"
"$TOOLS/linuxdeploy" \
  --appdir "$APP_DIR" \
  --desktop-file "$APP_DIR/$APP_NAME.desktop" \
  --icon-file "$APP_DIR/$APP_NAME.png" \
  --output appimage \
  $PLUGINS \
  || die "linuxdeploy falló (GUI webkit requiere gtk/gstreamer tools en el runner)"
test -s "$IMG_OUT" || die "linuxdeploy no produjo $IMG_OUT"
say "AppImage GUI: $(du -h "$IMG_OUT" | cut -f1)"

# ---------------------------------------------------------------- verificación mínima
step "Sanity del AppImage"
test -x "$APP_DIR/AppRun" || die "AppRun no ejecutable"
test -f "$APP_DIR/usr/lib/$APP_NAME/resources/server/package.json" || die "payload ausente en el AppDir"
test -x "$APP_DIR/usr/lib/$APP_NAME/bin/viewlba-installer" || die "sidecar ausente en el AppDir"
say "sanity OK (AppRun + payload + sidecar presentes)"

rm -rf "$APP_DIR"
echo ""
say "AppImage GUI LISTO: $IMG_OUT"
