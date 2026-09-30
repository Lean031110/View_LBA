/**
 * Tests de la BANDEJA del sistema (Windows + Linux) — el indicador
 * permanente de estado que pidió el usuario:
 *   «un icono permanente en la barra de tareas como indicador de que está
 *    activo y que cuando se le dé clic salgan opciones de iniciar, detener
 *    y configurar».
 *
 * Incluye la REGRESIÓN del 21.er build de v3.2.0 (la más importante de
 * este archivo): el Setup.exe de Windows quedaba COLGADO para siempre
 * porque lanzaba la bandeja con `nsExec::Exec`, que ESPERA a que el
 * proceso termine — y la bandeja es un bucle de mensajes INFINITO. El
 * comando correcto es `Exec` (no espera). Si alguien vuelve a escribir
 * nsExec::Exec para la bandeja, ESTE TEST ROMPE EL BUILD antes de
 * publicar un instalador roto.
 */
import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "prisma"))) return dir
    dir = dirname(dir)
  }
  return process.cwd()
})()

const TRAY_RUST_DIR = join(REPO, "installer", "native", "windows-tray")
const TRAY_SERVICE_HOST_DIR = join(REPO, "installer", "native", "windows-service")
const NSI = join(REPO, "installer", "windows", "viewlba-setup.nsi")
const TRAY_TS = join(REPO, "installer", "linux", "tray", "tray.ts")
const DBUS_TS = join(REPO, "installer", "linux", "tray", "dbus.ts")
const TRAY_ICONS = join(REPO, "installer", "linux", "tray", "icons")
const BUILD_DEB = join(REPO, "installer", "linux", "build-deb.ts")

// ---------------------------------------------------------------------------
// Windows — bandeja (binario Rust viewlba-tray.exe — misión §5)
// ---------------------------------------------------------------------------
// Fase 2: el tray PowerShell fue eliminado y reemplazado por un binario Rust
// que habla IPC con el service host via named pipe (\\.\pipe\viewlba-service).
// Estos tests verifican que la estructura Rust existe y el NSI la referencia.
describe("Bandeja Windows (viewlba-tray.exe binario Rust)", () => {
  test("existe el crate installer/native/windows-tray/", () => {
    expect(existsSync(TRAY_RUST_DIR)).toBe(true)
    expect(existsSync(join(TRAY_RUST_DIR, "Cargo.toml"))).toBe(true)
    expect(existsSync(join(TRAY_RUST_DIR, "src", "main.rs"))).toBe(true)
  })

  test("el crate declara dependencias correctas (NO PowerShell, NO NSSM)", () => {
    const cargo = readFileSync(join(TRAY_RUST_DIR, "Cargo.toml"), "utf8")
    expect(cargo).toMatch(/name\s*=\s*"viewlba-tray"/)
    expect(cargo).toMatch(/tray-icon/)
    expect(cargo).not.toMatch(/\bnssm\b/i)
  })

  test("single-instance via named mutex (Global\\viewlba-tray-single-instance)", () => {
    // MUTEX_NAME está en main.rs, pero la implementación de CreateMutexW
    // está en single_instance.rs. Verificamos ambos.
    const main = readFileSync(join(TRAY_RUST_DIR, "src", "main.rs"), "utf8")
    const singleInstance = readFileSync(join(TRAY_RUST_DIR, "src", "single_instance.rs"), "utf8")
    // main.rs define el nombre del mutex
    expect(main).toMatch(/Global\\\\viewlba-tray-single-instance/)
    expect(main).toMatch(/MUTEX_NAME/)
    expect(main).toMatch(/single_instance::acquire/)
    // single_instance.rs implementa CreateMutexW
    expect(singleInstance).toMatch(/CreateMutexW/)
    expect(singleInstance).toMatch(/ERROR_ALREADY_EXISTS/)
  })

  test("IPC client que habla a la named pipe del service host", () => {
    const ipc = readFileSync(join(TRAY_RUST_DIR, "src", "ipc.rs"), "utf8")
    expect(ipc).toMatch(/\\\\\.\\pipe\\viewlba-service|pipe_name/)
    expect(ipc).toMatch(/CreateFileW/)
  })

  test("config usa rutas Program Files + ProgramData (misión §3)", () => {
    const config = readFileSync(join(TRAY_RUST_DIR, "src", "config.rs"), "utf8")
    expect(config).toMatch(/Program Files/)
    expect(config).toMatch(/ProgramData/)
  })

  test("NO hay PowerShell ni NSSM en el Rust source del tray", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = []
      let entries: import("node:fs").Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return out
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          out.push(...walk(full))
        } else if (e.isFile() && full.endsWith(".rs")) {
          out.push(full)
        }
      }
      return out
    }
    for (const file of walk(TRAY_RUST_DIR)) {
      const content = readFileSync(file, "utf8")
      // Mencionar PowerShell en comentario ("NO PowerShell") está OK —
      // pero invocar powershell.exe para operaciones críticas no.
      // Patrón de INVOCACIÓN prohibida:
      expect(content).not.toMatch(/Command::new\(\s*["'`]powershell/)
      expect(content).not.toMatch(/Command::new\(\s*["'`]nssm/)
      expect(content).not.toMatch(/Command::new\(\s*["'`]sc\.exe/)
      expect(content).not.toMatch(/Command::new\(\s*["'`]find\.exe/)
    }
  })
})

// ---------------------------------------------------------------------------
// Windows — REGRESIÓN DEL CUELGUE DEL SETUP.exe (21.er build de v3.2.0)
// ---------------------------------------------------------------------------
describe("REGRESIÓN: lanzamiento de la bandeja en el NSI (21.er build)", () => {
  const nsi = readFileSync(NSI, "utf8")

  test("la bandeja se lanza con `Exec` (NO espera) — NUNCA con nsExec", () => {
    // La línea que lanza viewlba-tray.exe DEBE ser un Exec puro.
    const trayLines = nsi.split("\n").filter((l) => l.includes("viewlba-tray.exe") && !l.trimStart().startsWith(";"))
    expect(trayLines.length).toBeGreaterThan(0)
    for (const line of trayLines) {
      // toda línea que ARRANCA la bandeja debe usar Exec (con o sin prefijo)
      if (/Exec|ShellExec/i.test(line)) {
        expect(line).not.toMatch(/nsExec::Exec\b/)
      }
    }
  })

  test("ningún lanzamiento de proceso de larga vida usa nsExec::Exec sin /TIMEOUT", () => {
    // nsExec::Exec/ExecToLog ESPERAN al proceso: para procesos de larga vida
    // (bandeja) solo se admite /TIMEOUT acotado o Exec directo.
    const offenders = nsi
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^nsExec::Exec(\s|$)/.test(l))
      .filter((l) => !/\/TIMEOUT=/.test(l))
    // Las únicas llamadas nsExec::Exec «puras» permitidas: sidecar install
    // (que termina solo) y service install/uninstall (que terminan solos).
    for (const l of offenders) {
      expect(l).toMatch(/viewlba-installer|viewlba-service/)
    }
  })

  test("autostart de la bandeja con la sesión (HKCU Run)", () => {
    expect(nsi).toContain("CurrentVersion\\Run")
    expect(nsi).toContain("viewlba-tray.exe")
    expect(nsi).toContain("${APPNAME}Tray")
  })

  test("el desinstalador quita la bandeja (autostart + proceso)", () => {
    const uninstall = nsi.split('Section "Uninstall"')[1] ?? ""
    expect(uninstall).toContain("DeleteRegValue HKCU")
    // El NSI usa ${APPNAME}Tray que NSIS expande a "ViewLBA ServerTray" o
    // aceptamos también el patrón ViewLBATray sin espacio
    expect(uninstall).toMatch(/\$\{APPNAME\}Tray|ViewLBATray/)
  })

  test("accesos directos de la bandeja en escritorio + menú Inicio", () => {
    expect(nsi).toContain("ViewLBA - Bandeja.lnk")
    expect(nsi).toContain("$DESKTOP")
  })
})

// ---------------------------------------------------------------------------
// Linux — bandeja (TypeScript puro sobre el runtime bun EMPAQUETADO — v3.2.2:
// cero dependencias del sistema: sin python3-gi, sin GTK, sin gir — 100 % offline)
// ---------------------------------------------------------------------------
describe("Bandeja Linux (tray.ts — TypeScript sobre bun empaquetado)", () => {
  const ts = readFileSync(TRAY_TS, "utf8")

  test("existe (tray.ts + dbus.ts — la librería D-Bus propia)", () => {
    expect(existsSync(TRAY_TS)).toBe(true)
    expect(existsSync(DBUS_TS)).toBe(true)
  })

  test("menú con las opciones pedidas: Iniciar · Detener · Configurar", () => {
    for (const item of ["Iniciar servidor", "Detener servidor", "Reiniciar servidor", "Configurar…", "Abrir Panel", "Ver credenciales", "Salir"]) {
      expect(ts).toContain(item)
    }
  })

  test("indicador de estado por color de icono (running/stopped/waiting)", () => {
    expect(ts).toContain("ICON_BY_STATE")
    expect(ts).toContain("viewlba-running")
    expect(ts).toContain("viewlba-stopped")
    expect(ts).toContain("viewlba-waiting")
  })

  test("control del servicio con pkexec + systemctl (polkit estándar)", () => {
    expect(ts).toContain("pkexec")
    expect(ts).toContain("systemctl")
    expect(ts).toContain("pantalla-restaurante.target")
  })

  test("protocolos de escritorio: SNI + DBusMenu + Notifications (firmas exactas)", () => {
    expect(ts).toContain("org.kde.StatusNotifierItem")
    expect(ts).toContain("com.canonical.dbusmenu")
    expect(ts).toContain("org.freedesktop.Notifications")
    expect(ts).toContain("u(ia{sv}av)") // firma del layout DBusMenu (ksni + GNOME ext)
  })

  test("degradación elegante: sin DISPLAY → sale 0 (no rompe; el servidor sigue)", () => {
    expect(ts).toContain("WAYLAND_DISPLAY")
    expect(ts).toContain("sin sesión gráfica")
    expect(ts).toContain("el servidor sigue corriendo")
  })

  test("modo --check (verificación sin GUI para CI y diagnóstico)", () => {
    expect(ts).toContain("--check")
    expect(ts).toContain("selfCheck")
  })

  test("instancia única por pid-file (autostart + lanzamiento manual no duplican)", () => {
    expect(ts).toContain("acquireSingleInstance")
    expect(ts).toContain("viewlba-tray-")
    expect(ts).toContain("tray.ts") // verificación anti-pid-reutilizado
  })

  test("re-registro cuando el watcher SNI (re)aparece (match rule + tick)", () => {
    expect(ts).toContain("NameOwnerChanged")
    expect(ts).toContain("addMatch")
    expect(ts).toContain("registerWithWatcher")
  })

  test("sin dependencias del sistema: NADA de python/gi/gtk en el CÓDIGO de la bandeja", () => {
    // REGRESIÓN v3.2.2: la bandeja era Python3+PyGObject+GTK y fallaba en
    // máquinas sin python3-gi (offline, sin forma de instalarlo). Se comprueban
    // los PATRONES DE CÓDIGO reales (los comentarios pueden citar la historia).
    expect(ts).toContain("#!/usr/bin/env bun")
    expect(ts).not.toContain("gi.require_version")
    expect(ts).not.toContain("from gi.repository")
    expect(ts).not.toContain("import gi")
    expect(ts).not.toContain("Gtk.")
    expect(ts).not.toMatch(/spawn.*python/)
  })

  test("iconos de estado presentes (22/32/48 px × 3 estados)", () => {
    expect(existsSync(TRAY_ICONS)).toBe(true)
    const files = readdirSync(TRAY_ICONS)
    for (const state of ["running", "stopped", "waiting"]) {
      for (const size of [22, 32, 48]) {
        expect(files).toContain(`viewlba-${state}_${size}.png`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Linux — wiring del .deb (build-deb.ts instala la bandeja completa)
// ---------------------------------------------------------------------------
describe("Bandeja Linux — wiring del .deb (build-deb.ts)", () => {
  const deb = readFileSync(BUILD_DEB, "utf8")

  test("instala el CÓDIGO de la bandeja en /opt/viewlba-server/tray (sobrevive a la poda del postinst)", () => {
    expect(deb).toContain('join(ROOT, "opt", "viewlba-server", "tray")')
    expect(deb).toContain("tray.ts")
    expect(deb).toContain("dbus.ts")
  })

  test("/usr/bin/viewlba-tray es un WRAPPER que ejecuta la bandeja con el bun EMPAQUETADO", () => {
    expect(deb).toContain('join(ROOT, "usr", "bin", "viewlba-tray")')
    expect(deb).toContain("runtime/bun")
    expect(deb).toContain("tray/tray.ts")
    expect(deb).toContain("0o755")
  })

  test("instala los iconos de estado en hicolor", () => {
    expect(deb).toContain("viewlba-")
    expect(deb).toMatch(/hicolor/)
  })

  test("crea el lanzador de menú viewlba-tray.desktop", () => {
    expect(deb).toContain('"viewlba-tray.desktop"')
    expect(deb).toContain("Icon=viewlba-running")
  })

  test("autostart de sesión: /etc/xdg/autostart + copia al usuario en postinst", () => {
    expect(deb).toContain('"xdg", "autostart"')
    expect(deb).toContain("/etc/xdg/autostart/viewlba-tray.desktop")
    expect(deb).toContain("AUTOSTART_DIR")
  })

  test("postinst restaura el autostart XDG si el unpack no lo dejó (red defensiva)", () => {
    // REGRESIÓN: en los runners de GitHub Actions el archivo unpacked de
    // /etc/xdg/autostart NO aparecía (test -s fallaba en FLUJO 2). El
    // postinst debe auto-repararlo desde el lanzador del menú para que la
    // bandeja permanente autoarrance con la sesión SIEMPRE.
    expect(deb).toContain("if [ ! -s /etc/xdg/autostart/viewlba-tray.desktop ]; then")
    expect(deb).toContain("cp /usr/share/applications/viewlba-tray.desktop /etc/xdg/autostart/viewlba-tray.desktop")
  })

  test("el wrapper viewlba-server expone tray/configurar", () => {
    expect(deb).toContain("tray)")
    expect(deb).toContain("configure|configurar)")
  })

  test("postrm (purge) limpia autostart y accesos de la bandeja", () => {
    expect(deb).toContain('rm -f "$USER_HOME/.config/autostart/viewlba-tray.desktop"')
    expect(deb).toContain("viewlba-tray.desktop")
  })

  test("control: Depends SOLO systemd — la bandeja NO exige nada del sistema (offline real)", () => {
    // REGRESIÓN v3.2.2: antes «Recommends: python3, python3-gi, gir…» que
    // `dpkg -i` NO instala → máquina offline sin bandeja. Ahora la bandeja
    // corre con el bun empaquetado: cero paquetes del sistema. La única línea
    // de dependencias del control debe ser «Depends: systemd» (la Description
    // puede mencionar la decisión — es documentación).
    const controlTemplate = "Package: viewlba-server" + deb.split("`Package: viewlba-server")[1].split("`")[0]
    const depLines = controlTemplate
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(Depends|Recommends|Suggests|Pre-Depends|Enhances):/.test(l))
    expect(depLines).toEqual(["Depends: systemd"])
  })

  test("REGRESIÓN v3.2.3: cpSync con verbatimSymlinks — los symlinks del .deb NO pueden quedar con target absoluto", () => {
    // v3.2.0–v3.2.2 publicaron .debs con `runtime/bunx → /home/runner/work/…`
    // y `.bin/prisma → /home/runner/work/…`: fs.cpSync SIN verbatimSymlinks
    // RESUELVE los targets relativos del staging a rutas absolutas del
    // ENTORNO DE BUILD → en la máquina del usuario son enlaces ROTOS. La CI
    // no lo veía porque en el runner esa ruta existe (resuelven por
    // coincidencia); solo probar el .deb en OTRA máquina lo destapa.
    expect(deb).toContain("verbatimSymlinks: true")
    expect(deb).toContain("dereference: false")
    // Guard post-build: el script debe AUTO-VERIFICARSE y romper el build si
    // algún symlink del árbol empaquetado tiene target absoluto.
    expect(deb).toContain("readlinkSync")
    expect(deb).toMatch(/symlinks con target ABSOLUTO|target absoluto/)
  })
})

// ---------------------------------------------------------------------------
// Linux — bandeja E2E REAL (dbus-daemon + watcher SNI simulado): ver
// tests/installer/tray-dbus.test.ts (marshalling golden + integración + e2e)
// ---------------------------------------------------------------------------
