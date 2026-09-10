#!/usr/bin/env bash
# ============================================================================
# Reproducción LOCAL del fallo de linuxdeploy (tauri-bundler oculta stderr).
# Construye un AppDir equivalente al de Tauri y ejecuta linuxdeploy + plugins
# con el MISMO entorno que CI (APPIMAGE_EXTRACT_AND_RUN=1).
# ============================================================================
set -uo pipefail
WORK=/tmp/linuxdeploy-repro
rm -rf "$WORK" && mkdir -p "$WORK/AppDir/usr/bin" "$WORK/AppDir/usr/lib/viewlba-server" "$WORK/bin"

STAGE="${1:-/home/z/my-project/dist/release/linux/ViewLBA-Server}"
[[ -d "$STAGE/resources/server" ]] || { echo "staging ausente: $STAGE"; exit 2; }

# ---- binario "GUI" (dummy ELF con dependencias mínimas reales: un shim C) ----
cat > "$WORK/gui.c" <<'EOF'
#include <stdio.h>
int main(){ puts("gui-dummy"); return 0; }
EOF
gcc "$WORK/gui.c" -o "$WORK/AppDir/usr/bin/viewlba-installer-gui" || exit 1

# sidecar + payload + runtime (IGUAL que tauri.conf resources/externalBin)
cp "$STAGE/viewlba-installer" "$WORK/AppDir/usr/bin/" 2>/dev/null || true
cp -a "$STAGE/resources/server" "$WORK/AppDir/usr/lib/viewlba-server/resources/server"
cp -a "$STAGE/runtime" "$WORK/AppDir/usr/lib/viewlba-server/resources/runtime"
cp "$STAGE/manifest.json" "$WORK/AppDir/usr/lib/viewlba-server/resources/" 2>/dev/null || true

# ---- icon + desktop (como tauri-bundler) ----
cp /home/z/my-project/installer/gui/src-tauri/icons/icon.png "$WORK/AppDir/viewlba-server.png"
cat > "$WORK/AppDir/viewlba-server.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=ViewLBA Server
Exec=viewlba-installer-gui
Icon=viewlba-server
Terminal=false
Categories=System;
EOF

# ---- AppRun (como tauri lo genera para appimage) ----
cat > "$WORK/AppDir/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/viewlba-installer-gui" "$@"
EOF
chmod +x "$WORK/AppDir/AppRun"

# ---- herramientas (las mismas URLs que tauri-bundler) ----
cd "$WORK/bin"
D=https://github.com/tauri-apps/binary-releases/releases/download
curl -fsSL -o linuxdeploy "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage" || exit 1
curl -fsSL -o plugin-gtk.sh "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh"
curl -fsSL -o plugin-gstreamer.sh "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh"
curl -fsSL -o plugin-appimage "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage"
chmod +x linuxdeploy plugin-gtk.sh plugin-gstreamer.sh plugin-appimage

# ---- ejecutar IGUAL que CI ----
export APPIMAGE_EXTRACT_AND_RUN=1
export OUTPUT=AppImage
echo "===== linuxdeploy con plugins gtk+gstreamer (como tauri) ====="
./linuxdeploy --appdir "$WORK/AppDir" \
  --desktop-file "$WORK/AppDir/viewlba-server.desktop" \
  --icon-file "$WORK/AppDir/viewlba-server.png" \
  --output appimage \
  --plugin gtk --plugin gstreamer 2>&1 | tail -30
echo "exit=${PIPESTATUS[0]}"
