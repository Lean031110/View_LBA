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
import { existsSync, readFileSync, readdirSync } from "node:fs"
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

const TRAY_PS1 = join(REPO, "installer", "windows", "tray", "ViewLBA-Tray.ps1")
const NSI = join(REPO, "installer", "windows", "viewlba-setup.nsi")
const TRAY_TS = join(REPO, "installer", "linux", "tray", "tray.ts")
const DBUS_TS = join(REPO, "installer", "linux", "tray", "dbus.ts")
const TRAY_ICONS = join(REPO, "installer", "linux", "tray", "icons")
const BUILD_DEB = join(REPO, "installer", "linux", "build-deb.ts")

// ---------------------------------------------------------------------------
// Windows — bandeja (PowerShell, cero dependencias)
// ---------------------------------------------------------------------------
describe("Bandeja Windows (ViewLBA-Tray.ps1)", () => {
  const ps1 = readFileSync(TRAY_PS1, "utf8")

  test("existe y compila sintácticamente (estructura básica)", () => {
    expect(existsSync(TRAY_PS1)).toBe(true)
    // llaves balanceadas (validación ligera — el parseo REAL lo hace el CI
    // de Windows con el parser de PowerShell del propio runner)
    const open = (ps1.match(/\{/g) ?? []).length
    const close = (ps1.match(/\}/g) ?? []).length
    expect(open).toBe(close)
    const popen = (ps1.match(/\(/g) ?? []).length
    const pclose = (ps1.match(/\)/g) ?? []).length
    expect(popen).toBe(pclose)
  })

  test("menú con las opciones pedidas: Iniciar · Detener · Configurar", () => {
    for (const item of ["Iniciar servidor", "Detener servidor", "Reiniciar servidor", "Configurar...", "Abrir Panel", "Salir"]) {
      expect(ps1).toContain(item)
    }
  })

  test("100 % ASCII — PS 5.1 sin BOM no puede romperlo con el codepage (regresión del 5.º build)", () => {
    // EVIDENCIA del build 5: el .ps1 en UTF-8 sin BOM con em-dash (0x94 en
    // CP1252 = comilla curva = TERMINADOR de cadena) rompía el parse de
    // Windows PowerShell 5.1 → la bandeja NUNCA ARRANCABA. ASCII puro =
    // inmune en cualquier codepage de cualquier Windows.
    const raw = readFileSync(TRAY_PS1)
    const bad: number[] = []
    raw.forEach((b, i) => { if (b > 127) bad.push(i) })
    expect(bad).toEqual([])
  })

  test("ventana «Configurar…» con control completo (estado + acciones + carpetas)", () => {
    expect(ps1).toContain("Open-ConfigWindow")
    for (const btn of ["Iniciar servidor", "Detener servidor", "Reiniciar servidor", "Abrir Panel", "Ver credenciales", "Carpeta de datos", "Carpeta del programa", "Ver registros (logs)"]) {
      expect(ps1).toContain(`T = '${btn}'`)
    }
  })

  test("indicador de estado con colores (verde activo · rojo detenido · amarillo transición)", () => {
    expect(ps1).toContain("$IconRun")
    expect(ps1).toContain("$IconStop")
    expect(ps1).toContain("$IconWait")
    expect(ps1).toMatch(/running.*\$IconRun| \$IconRun\.Icon/)
    expect(ps1).toContain("EN EJECUC")
  })

  test("instancia única por pid-file (autostart + instalador no duplican la bandeja)", () => {
    expect(ps1).toContain("tray.pid")
    expect(ps1).toMatch(/Get-Process -Id \(\[int\]\$other\)/)
    expect(ps1).toContain("if ($proc -and $proc.ProcessName -match 'powershell') { exit 0 }")
    // el pid se registra ANTES de cargar WinForms (arranque rápido)
    const pidPos = ps1.indexOf("Set-Content -Path $PidFile")
    const addTypePos = ps1.indexOf("Add-Type -AssemblyName System.Windows.Forms")
    expect(pidPos).toBeGreaterThan(0)
    expect(pidPos).toBeLessThan(addTypePos)
  })

  test("refresco periódico del estado (timer ≤ 10 s)", () => {
    expect(ps1).toMatch(/\$script:timer\.Interval = \d+/)
    const interval = Number(ps1.match(/\$script:timer\.Interval = (\d+)/)?.[1] ?? 0)
    expect(interval).toBeGreaterThan(0)
    expect(interval).toBeLessThanOrEqual(10000)
  })

  test("notificación (globo) al usuario: bienvenida y cambio de estado", () => {
    expect(ps1).toContain("Show-Balloon")
    expect(ps1).toContain("ShowBalloonTip")
  })

  test("control del servicio vía UAC estándar (net start/stop)", () => {
    expect(ps1).toContain("'net.exe'")
    expect(ps1).toContain("-Verb RunAs")
    expect(ps1).toContain("PantallaRestaurante")
  })
})

// ---------------------------------------------------------------------------
// Windows — REGRESIÓN DEL CUELGUE DEL SETUP.exe (21.er build de v3.2.0)
// ---------------------------------------------------------------------------
describe("REGRESIÓN: lanzamiento de la bandeja en el NSI (21.er build)", () => {
  const nsi = readFileSync(NSI, "utf8")

  test("la bandeja se lanza con `Exec` (NO espera) — NUNCA con nsExec", () => {
    // La línea que lanza ViewLBA-Tray.ps1 DEBE ser un Exec puro.
    const trayLines = nsi.split("\n").filter((l) => l.includes("ViewLBA-Tray.ps1") && !l.trimStart().startsWith(";"))
    expect(trayLines.length).toBeGreaterThan(0)
    for (const line of trayLines) {
      // toda línea que ARRANCA la bandeja debe usar Exec (con o sin prefijo)
      if (/Exec|ShellExec|powershell/i.test(line)) {
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
      .filter((l) => !/powershell\.exe/i.test(l) || /ViewLBA-Tray/i.test(l))
    // las únicas llamadas nsExec::Exec «puras» permitidas: matar procesos y
    // generar la contraseña (ambas terminan solas en <2 s)
    for (const l of offenders) {
      expect(l).toMatch(/Stop-Process|\.pwd\.tmp/)
    }
  })

  test("autostart de la bandeja con la sesión (HKCU Run)", () => {
    expect(nsi).toContain("CurrentVersion\\Run")
    expect(nsi).toContain("ViewLBA-Tray.ps1")
    expect(nsi).toContain("${APPNAME}Tray")
  })

  test("el desinstalador quita la bandeja (autostart + proceso)", () => {
    const uninstall = nsi.split('Section "Uninstall"')[1] ?? ""
    expect(uninstall).toContain("DeleteRegValue HKCU")
    expect(uninstall).toMatch(/ViewLBA-Tray|ViewLBATray/)
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
