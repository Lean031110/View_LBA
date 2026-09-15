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
const TRAY_PY = join(REPO, "installer", "linux", "tray", "viewlba-tray.py")
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
    for (const item of ["Iniciar servidor", "Detener servidor", "Reiniciar servidor", "Configurar…", "Abrir Panel", "Salir"]) {
      expect(ps1).toContain(item)
    }
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
// Linux — bandeja (Python3 + GTK/AppIndicator, degradación elegante)
// ---------------------------------------------------------------------------
describe("Bandeja Linux (viewlba-tray.py)", () => {
  const py = readFileSync(TRAY_PY, "utf8")

  test("existe", () => {
    expect(existsSync(TRAY_PY)).toBe(true)
  })

  test("menú con las opciones pedidas: Iniciar · Detener · Configurar", () => {
    for (const item of ["Iniciar servidor", "Detener servidor", "Reiniciar servidor", "Configurar…", "Abrir Panel", "Salir"]) {
      expect(py).toContain(item)
    }
  })

  test("indicador de estado por color de icono (running/stopped/waiting)", () => {
    expect(py).toContain("ICON_BY_STATE")
    expect(py).toContain("viewlba-running")
    expect(py).toContain("viewlba-stopped")
    expect(py).toContain("viewlba-waiting")
  })

  test("control del servicio con pkexec + systemctl (polkit estándar)", () => {
    expect(py).toContain("pkexec")
    expect(py).toContain("systemctl")
    expect(py).toContain("pantalla-restaurante.target")
  })

  test("degradación elegante: sin DISPLAY, sin python3-gi → sale 0 (no rompe)", () => {
    expect(py).toContain("WAYLAND_DISPLAY")
    expect(py).toMatch(/return 0/)
    expect(py).toContain("python3-gi")
  })

  test("modo --check (verificación sin GUI para CI y diagnóstico)", () => {
    expect(py).toContain("--check")
    expect(py).toContain("self_check")
  })

  test("ventana «Configurar…» con estado + credenciales + carpetas", () => {
    expect(py).toContain("open_config_window")
    for (const btn of ["Ver credenciales", "Carpeta de datos", "Carpeta del programa", "Ver registros (logs)"]) {
      expect(py).toContain(`"${btn}"`)
    }
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

  test("instala /usr/bin/viewlba-tray (ejecutable)", () => {
    expect(deb).toContain('join(ROOT, "usr", "bin", "viewlba-tray")')
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

  test("el wrapper viewlba-server expone tray/configurar", () => {
    expect(deb).toContain("tray)")
    expect(deb).toContain("configure|configurar)")
  })

  test("postrm (purge) limpia autostart y accesos de la bandeja", () => {
    expect(deb).toContain('rm -f "$USER_HOME/.config/autostart/viewlba-tray.desktop"')
    expect(deb).toContain("viewlba-tray.desktop")
  })

  test("control: Recommends de las dependencias de la bandeja (no Depends — el servidor funciona headless)", () => {
    expect(deb).toContain("Recommends:")
    expect(deb).toContain("python3-gi")
    expect(deb).toContain("appindicator")
    // Depends SOLO systemd: la bandeja es opcional por diseño
    expect(deb).toMatch(/Depends: systemd\n/)
  })
})
