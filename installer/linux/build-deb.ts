/**
 * build-deb.ts — Paquete .deb NATIVO de ViewLBA Server (sin Tauri, sin GUI).
 *
 * MISIÓN (feedback del usuario): «como un programa nativo de Linux: instalar
 * y ejecutar, todo sencillo, sin dependencias que instalar a mano»:
 *
 *   · El payload va COMPLETO dentro del .deb (servidor Next.js standalone
 *     + runtime bun INCLUIDO). La máquina del usuario NO necesita node, bun
 *     ni npm: `dpkg -i` y ya.
 *   · postinst ejecuta el sidecar `viewlba-installer --config` (modo
 *     unattended): crea usuario de sistema, instala las unidades systemd,
 *     prepara la DB SQLite + admin y ARRANCA el servicio (enable --now
 *     implícito: el servidor se reinicia con el equipo).
 *   · Credenciales del administrador generadas en la máquina (CREDENCIALES.txt)
 *     — nunca embebidas en el paquete.
 *   · Accesos directos: /usr/share/applications (menú) + copia al escritorio
 *     del usuario que instala (SUDO_USER): Panel · Iniciar · Detener.
 *   · prerm detiene los servicios; postrm (purge) desinstala vía sidecar.
 *
 * Uso:
 *   bun installer/linux/build-deb.ts \
 *        [--staging=dist/release/linux/ViewLBA-Server] \
 *        [--version=3.2.0] [--out=dist/release/linux/out]
 *
 * Regla de la misión: sin comandos POSIX en este script (fs + dpkg-deb).
 */
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "prisma"))) return dir
    dir = dirname(dir)
  }
  return process.cwd()
})()

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")

const STAGING = arg("staging") ?? join(REPO, "dist", "release", "linux", "ViewLBA-Server")
const VERSION = arg("version") ?? readFileSync(join(REPO, "VERSION"), "utf8").trim()
const OUT_DIR = arg("out") ?? join(REPO, "dist", "release", "linux", "out")
const OUT_FILE = join(OUT_DIR, `ViewLBA-Server-${VERSION}-x86_64.deb`)

const PKG_DIR = "/opt/viewlba-server" // paquete (sidecar + runtime + manifest)
const ICONS_SRC = join(REPO, "installer", "gui", "src-tauri", "icons")

// --------------------------------------------------------------------------
// Contrato del staging (falla ANTES de empaquetar si el payload está cojo)
// --------------------------------------------------------------------------
const REQUIRED = [
  join(STAGING, "viewlba-installer"),
  join(STAGING, "manifest.json"),
  join(STAGING, "resources", "server", "package.json"),
  join(STAGING, "resources", "server", ".next", "standalone", "server.js"),
  join(STAGING, "runtime", "bun"),
]
for (const p of REQUIRED) {
  if (!existsSync(p)) {
    console.error(`✗ falta ${p} — ejecuta antes installer/package/bundle-server.ts --platform=linux`)
    process.exit(1)
  }
}
chmodSync(join(STAGING, "viewlba-installer"), 0o755)
chmodSync(join(STAGING, "runtime", "bun"), 0o755)
console.log(`✓ payload verificado: ${STAGING} (${(treeMB(STAGING)).toFixed(0)} MB)`)

// --------------------------------------------------------------------------
// Árbol del .deb
// --------------------------------------------------------------------------
const ROOT = join(OUT_DIR, ".deb-root")
rmSync(ROOT, { recursive: true, force: true })
const pkg = join(ROOT, "opt", "viewlba-server")
mkdirSync(pkg, { recursive: true })

// 1) payload completo (se PODA en el postinst tras instalar: resources/server
//    se copia a /opt/pantalla-restaurante y el duplicado se borra)
// ⚠ dereference: FALSE — el payload recrea node_modules/.bin/* como
// SYMLINKS relativos (../prisma/build/index.js): si se desreferencian
// aquí, el shim queda como COPIA del index.js y su resolución relativa
// rompe (prisma busca prisma_schema_build_bg.wasm EN .bin/ → ENOENT —
// bug real del tercer build de v3.2.0). dpkg-deb/tar preserva symlinks.
cpSync(STAGING, pkg, { recursive: true, dereference: false })
console.log("✓ payload copiado a /opt/viewlba-server")

// Guard: el contrato .bin→symlink del payload DEBE llegar intacto al .deb
const debBinPrisma = join(pkg, "resources", "server", "node_modules", ".bin", "prisma")
if (existsSync(debBinPrisma) && !lstatSync(debBinPrisma).isSymbolicLink()) {
  console.error("✗ node_modules/.bin/prisma NO es un symlink — la resolución del wasm de prisma romperá en destino")
  process.exit(1)
}

// 2) wrapper de línea de comandos: `viewlba-server start|stop|restart|status|health|logs|panel|credentials`
const BIN = join(ROOT, "usr", "bin")
mkdirSync(BIN, { recursive: true })
writeFileSync(
  join(BIN, "viewlba-server"),
  `#!/bin/sh
# viewlba-server — control simple del servidor ViewLBA (wrapper del sidecar).
# Uso: viewlba-server {start|stop|restart|status|health|logs|panel|credentials}
set -e
PKG=${PKG_DIR}
case "\${1:-status}" in
  start|stop|restart)
    exec "$PKG/viewlba-installer" services "\$1" ;;
  status)
    exec "$PKG/viewlba-installer" services status ;;
  health)
    exec "$PKG/viewlba-installer" health ;;
  logs)
    exec "$PKG/viewlba-installer" logs ;;
  panel)
    exec xdg-open http://localhost:3000 ;;
  credentials)
    exec cat "$PKG/CREDENCIALES.txt" ;;
  *)
    echo "uso: viewlba-server {start|stop|restart|status|health|logs|panel|credentials}" >&2
    exit 2 ;;
esac
`,
)
chmodSync(join(BIN, "viewlba-server"), 0o755)
console.log("✓ /usr/bin/viewlba-server (start · stop · status · health · panel)")

// 3) iconos (hicolor — mismos PNG del producto)
const ICON_MAP: Array<[string, string]> = [
  ["32x32.png", "32x32"],
  ["128x128.png", "128x128"],
  ["icon.png", "512x512"],
]
for (const [srcName, sizeDir] of ICON_MAP) {
  const src = join(ICONS_SRC, srcName)
  if (!existsSync(src)) continue
  const dst = join(ROOT, "usr", "share", "icons", "hicolor", sizeDir, "apps")
  mkdirSync(dst, { recursive: true })
  cpSync(src, join(dst, "viewlba.png"))
}

// 4) .desktop (menú de aplicaciones + copia al escritorio en el postinst)
const APPS = join(ROOT, "usr", "share", "applications")
mkdirSync(APPS, { recursive: true })
writeFileSync(
  join(APPS, "viewlba-panel.desktop"),
  `[Desktop Entry]
Type=Application
Name=ViewLBA — Panel
Name[es]=ViewLBA — Panel
Comment=Abrir el panel del servidor (localhost:3000)
Comment[es]=Abrir el panel del servidor (localhost:3000)
Exec=xdg-open http://localhost:3000
Icon=viewlba
Terminal=false
Categories=Network;
StartupNotify=true
`,
)
for (const [file, action] of [
  ["viewlba-start.desktop", "start"],
  ["viewlba-stop.desktop", "stop"],
] as const) {
  writeFileSync(
    join(APPS, file),
    `[Desktop Entry]
Type=Application
Name=ViewLBA — ${action === "start" ? "Iniciar servidor" : "Detener servidor"}
Name[es]=ViewLBA — ${action === "start" ? "Iniciar servidor" : "Detener servidor"}
Comment=${action === "start" ? "Arrancar" : "Detener"} el servicio de ViewLBA (pide contraseña de admin)
Exec=pkexec systemctl ${action} pantalla-restaurante.target
Icon=viewlba
Terminal=true
Categories=System;
`,
  )
}
console.log("✓ accesos .desktop (Panel · Iniciar · Detener)")

// --------------------------------------------------------------------------
// DEBIAN/control
// --------------------------------------------------------------------------
const DEB = join(ROOT, "DEBIAN")
mkdirSync(DEB, { recursive: true })
const installedSizeKB = Math.round(treeMB(ROOT) * 1024)
writeFileSync(
  join(DEB, "control"),
  `Package: viewlba-server
Version: ${VERSION}
Architecture: amd64
Maintainer: ViewLBA <soporte@viewlba.local>
Installed-Size: ${installedSizeKB}
Depends: systemd
Section: net
Priority: optional
Homepage: https://github.com/Lean031110/Pantalla_Restaurante
Description: ViewLBA Server — pantallas de menú para restaurantes
 Servidor Next.js + servicios realtime/stream para pantallas de restaurantes.
 .
 Incluye SU PROPIO runtime (bun): NO requiere Node.js, npm ni Bun instalados.
 Al instalar: crea el usuario de sistema, registra y ARRANCA el servicio
 systemd (se reinicia con el equipo) y genera las credenciales del admin
 (/opt/viewlba-server/CREDENCIALES.txt). Panel: http://localhost:3000.
`,
)

// --------------------------------------------------------------------------
// DEBIAN/postinst — instalación REAL (idempotente, sin preguntas)
// --------------------------------------------------------------------------
writeFileSync(
  join(DEB, "postinst"),
  `#!/bin/sh
# postinst viewlba-server — instala y ARRANCA el servidor (idempotente).
# Sin debconf, sin preguntas: «instalar y ejecutar».
set -e
PKG=${PKG_DIR}
APP=/opt/pantalla-restaurante

gen_password() {
  # Política del servidor: 10+ chars, mayúscula + minúscula + dígito.
  echo "ViewLBA-$( (cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N) | tr -d '-' | cut -c1-8 | tr 'a-f' 'A-F')-7x"
}

case "$1" in
  configure)
    # 1) credenciales + config SOLO la primera vez (nunca regenerar en
    #    upgrades/reinstalaciones: el usuario ya cambió quizá la contraseña)
    if [ ! -f "$PKG/CREDENCIALES.txt" ]; then
      PWD_GEN=$(gen_password)
      cat > "$PKG/install-config.json" <<EOF_CONFIG
{"mode":"new","restaurantName":"Mi Restaurante","timezone":"America/Havana","webPort":3000,"realtimePort":3003,"rtmpPort":1935,"httpFlvPort":8000,"lanMode":false,"adminEmail":"admin@viewlba.local","adminPassword":"$PWD_GEN","withDemoData":false,"offline":true,"runBuild":false}
EOF_CONFIG
      chmod 600 "$PKG/install-config.json"
      cat > "$PKG/CREDENCIALES.txt" <<EOF_CRED
ViewLBA Server ${VERSION} - Credenciales del administrador

Panel:   http://localhost:3000
Usuario: admin@viewlba.local
Clave:   $PWD_GEN

(Guárdalas en un lugar seguro; puedes cambiar la clave desde el panel:
 Usuarios - editar administrador.)
EOF_CRED
      chmod 600 "$PKG/CREDENCIALES.txt"
      echo "viewlba-server: credenciales del admin generadas en $PKG/CREDENCIALES.txt"
    fi

    # 2) instalación REAL (usuario, unidades systemd, DB, admin, arranque).
    #    Idempotente: si ya hay instalación, solo asegura servicios activos.
    if [ ! -f "$APP/package.json" ]; then
      echo "viewlba-server: instalando servidor + servicio systemd (puede tardar un poco)…"
      if ! "$PKG/viewlba-installer" --config "$PKG/install-config.json"; then
        echo "" >&2
        echo "✗ La instalación del servidor falló. Registro del intento:" >&2
        echo "   · Reinstala: sudo apt install --reinstall ./viewlba-server.deb" >&2
        echo "   · Diagnóstico manual: $PKG/viewlba-installer diagnostics" >&2
        exit 1
      fi
    else
      echo "viewlba-server: instalación previa detectada — asegurando servicios…"
      systemctl daemon-reload || true
      systemctl restart pantalla-restaurante.target || true
    fi

    # 3) PODAR el duplicado del payload (~400 MB): la app ya vive en
    #    $APP (autosuficiente). El paquete conserva sidecar + runtime +
    #    manifest para gestión (start/stop/health/uninstall).
    if [ -d "$APP/package.json" ] || [ -f "$APP/package.json" ]; then
      rm -rf "$PKG/resources/server"
    fi

    # 4) accesos directos al ESCRITORIO del usuario que instala
    SUDO_USER=\${SUDO_USER:-}
    if [ -n "$SUDO_USER" ]; then
      USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6) || USER_HOME=""
      for D in "Desktop" "Escritorio" ".config/autostart-dir"; do
        DESK="$USER_HOME/$D"
        if [ -d "$DESK" ]; then
          for F in viewlba-panel.desktop viewlba-start.desktop viewlba-stop.desktop; do
            cp "/usr/share/applications/$F" "$DESK/$F" 2>/dev/null || true
            chmod 755 "$DESK/$F" 2>/dev/null || chmod +x "$DESK/$F" 2>/dev/null || true
          done
          break
        fi
      done
    fi

    # 5) resumen visible (estilo programa nativo)
    echo ""
    echo "  ✓ ViewLBA Server instalado y EN EJECUCIÓN"
    echo "  ─────────────────────────────────────────────"
    echo "  Panel:       http://localhost:3000"
    echo "  Credenciales: sudo cat $PKG/CREDENCIALES.txt"
    echo "  Control:      viewlba-server {start|stop|status|health|logs}"
    echo "  El servidor se inicia automáticamente con el equipo."
    echo ""
    ;;
  abort-upgrade|abort-remove|abort-deconfigure)
    ;;
esac
exit 0
`,
)
chmodSync(join(DEB, "postinst"), 0o755)

// --------------------------------------------------------------------------
// DEBIAN/prerm + postrm
// --------------------------------------------------------------------------
writeFileSync(
  join(DEB, "prerm"),
  `#!/bin/sh
# prerm — detener los servicios antes de quitar/actualizar el paquete.
set -e
case "$1" in
  remove|upgrade|deconfigure)
    systemctl stop pantalla-restaurante.target 2>/dev/null || true
    ;;
  failed-upgrade)
    ;;
esac
exit 0
`,
)
chmodSync(join(DEB, "prerm"), 0o755)

writeFileSync(
  join(DEB, "postrm"),
  `#!/bin/sh
# postrm — purge: quitar servicios + app por completo (conserva DB/backups
# salvo purge explícito: los datos del restaurante NUNCA se pierden «de paso»).
set -e
PKG=${PKG_DIR}
case "$1" in
  purge)
    if [ -x "$PKG/viewlba-installer" ]; then
      "$PKG/viewlba-installer" uninstall --confirm 2>/dev/null || true
    fi
    rm -rf "$PKG" 2>/dev/null || true
    for U in pantalla-restaurante.service pantalla-restaurante-realtime.service \\
             pantalla-restaurante-stream.service pantalla-restaurante.target \\
             pantalla-restaurante-backup.service pantalla-restaurante-backup.timer \\
             pantalla-restaurante-logs-purge.service pantalla-restaurante-logs-purge.timer; do
      rm -f "/etc/systemd/system/$U" 2>/dev/null || true
    done
    systemctl daemon-reload 2>/dev/null || true
    userdel pantalla 2>/dev/null || true
    echo "viewlba-server: purgado. Los DATOS se conservaron en /var/lib/pantalla-restaurante"
    echo "                 (bórralos a mano si ya no los necesitas: sudo rm -rf /var/lib/pantalla-restaurante)"
    ;;
  remove|upgrade|failed-upgrade)
    ;;
esac
exit 0
`,
)
chmodSync(join(DEB, "postrm"), 0o755)

// --------------------------------------------------------------------------
// Empaquetar (dpkg-deb)
// --------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true })
rmSync(OUT_FILE, { force: true })
const build = spawnSync("dpkg-deb", ["--build", "--root-owner-group", ROOT, OUT_FILE], {
  encoding: "utf8",
  cwd: REPO,
})
if (build.status !== 0) {
  console.error(`✗ dpkg-deb falló:\n${(build.stderr || build.stdout || "").slice(0, 2000)}`)
  process.exit(1)
}
rmSync(ROOT, { recursive: true, force: true })

const sizeMB = (statSync(OUT_FILE).size / 1024 / 1024).toFixed(0)
console.log(`✓ .deb construido: ${OUT_FILE} (${sizeMB} MB)`)
console.log(`  instalación:  sudo dpkg -i ViewLBA-Server-${VERSION}-x86_64.deb`)
console.log(`  el postinst instala y ARRANCA el servicio (systemd) + credenciales + accesos`)

function treeMB(root: string): number {
  let bytes = 0
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else bytes += statSync(p).size
    }
  }
  walk(root)
  return bytes / 1024 / 1024
}
