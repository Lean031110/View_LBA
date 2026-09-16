#!/usr/bin/env bun
/**
 * viewlba-tray — Bandeja del sistema para ViewLBA Server (Linux) en TypeScript.
 *
 * MISIÓN (pedida por el usuario): «un icono PERMANENTE en la barra de tareas
 * como indicador de que está activo y que al hacer clic sobre él salgan
 * opciones de iniciar, detener y configurar».
 *
 * REQUISITO NUEVO (v3.2.2, offline 100 %): la bandeja anterior era
 * Python3 + PyGObject + GTK (python3-gi), una dependencia del SISTEMA que
 * `dpkg -i` NO instala (era un «Recommends») y que una máquina SIN RED no
 * puede conseguir → la bandeja no arrancaba. Esta versión habla el protocolo
 * StatusNotifierItem (SNI) + DBusMenu + Notifications DIRECTAMENTE sobre el
 * bus de sesión, y corre con el MISMO runtime bun que el .de b ya incluye
 * (`/opt/viewlba-server/runtime/bun`). CERO dependencias nuevas: si la
 * máquina puede mostrar una bandeja (KDE/XFCE/MATE/Cinnamon nativos; Ubuntu
 * GNOME con gnome-shell-extension-appindicator preinstalado), esta bandeja
 * funciona — offline, sin instalar nada.
 *
 *   · Icono de estado (hicolor, instalado por el .deb):
 *       VERDE (viewlba-running)   = servidor EN EJECUCIÓN
 *       ROJO (viewlba-stopped)    = servidor DETENIDO
 *       AMARILLO (viewlba-waiting) = arrancando / deteniendo
 *   · Clic derecho → Iniciar servidor · Detener servidor · Reiniciar ·
 *     Configurar… · Abrir Panel · Ver credenciales · Salir.
 *   · Clic izquierdo (Activate) → abre el Panel (toda la configuración del
 *     restaurante vive en el panel web).
 *   · Refresco automático cada 5 s (1 s tras una acción) + notificaciones
 *     del sistema en cada cambio de estado.
 *   · Sin escritorio / sin bus de sesión: mensaje claro y salida 0 — el
 *     servidor NO se ve afectado (degradación elegante, igual que la
 *     bandeja de Windows en headless).
 *   · Instancia única (pid-file en XDG_RUNTIME_DIR).
 *
 * Uso: viewlba-tray            (o desde el menú «ViewLBA — Bandeja»)
 *      viewlba-tray --check    (verificación sin GUI: script, unidad
 *                               systemd, wrapper CLI y runtime bundlado)
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { DBusConnection, DBusError, Variant } from "./dbus"

// ---------------------------------------------------------------------------
// Configuración (env-overridable — los tests usan binarios falsos)
// ---------------------------------------------------------------------------

const env = (name: string, def: string): string => process.env[name] || def

const SERVICE = env("VIEWLBA_TRAY_SERVICE", "pantalla-restaurante.service")
const TARGET = env("VIEWLBA_TRAY_TARGET", "pantalla-restaurante.target")
const PANEL_URL = env("VIEWLBA_TRAY_PANEL_URL", "http://localhost:3000")
const APP_NAME = "ViewLBA Server"
const CRED_FILE = env("VIEWLBA_TRAY_CRED_FILE", "/opt/viewlba-server/CREDENCIALES.txt")
const DATA_DIR = env("VIEWLBA_TRAY_DATA_DIR", "/var/lib/pantalla-restaurante")
const LOG_DIR = env("VIEWLBA_TRAY_LOG_DIR", "/var/log/pantalla-restaurante")

const SYSTEMCTL = env("VIEWLBA_TRAY_SYSTEMCTL", "systemctl")
const PKEXEC = env("VIEWLBA_TRAY_PKEXEC", "pkexec")
const OPENER = env("VIEWLBA_TRAY_XDG_OPEN", "xdg-open")

// intervalos de sondeo (env-overridable — los tests usan intervalos cortos)
const TICK_MS = Number(env("VIEWLBA_TRAY_TICK_MS", "5000"))
const FAST_TICK_MS = Number(env("VIEWLBA_TRAY_FAST_TICK_MS", "1000"))

const SNI_PATH = "/StatusNotifierItem"
const MENU_PATH = "/MenuBar"
const SNI_IFACE = "org.kde.StatusNotifierItem"
const MENU_IFACE = "com.canonical.dbusmenu"
const WATCHER = "org.kde.StatusNotifierWatcher"
const NOTIFICATIONS = "org.freedesktop.Notifications"

// Nombres de icono del tema hicolor (los instala el .deb)
const ICON_BY_STATE: Record<string, string> = {
  running: "viewlba-running",
  starting: "viewlba-waiting",
  stopping: "viewlba-waiting",
  stopped: "viewlba-stopped",
  missing: "viewlba-stopped",
}

const STATE_LABEL: Record<string, string> = {
  running: "Estado: EN EJECUCIÓN",
  starting: "Estado: iniciando…",
  stopping: "Estado: deteniendo…",
  stopped: "Estado: DETENIDO",
  missing: "Estado: servicio NO instalado",
}

const STATE_TIP: Record<string, string> = {
  running: "El servidor está activo — panel en " + PANEL_URL,
  starting: "El servidor está iniciando…",
  stopping: "El servidor se está deteniendo…",
  stopped: "El servidor está detenido — clic derecho para iniciarlo",
  missing: "El servicio no está instalado en esta máquina",
}

// ---------------------------------------------------------------------------
// Modelo del menú (DBusMenu)
// ---------------------------------------------------------------------------

interface MenuItem {
  id: number
  label?: string
  separator?: boolean
  action?: string
  /** Sensibilidad según el estado (se reevalúa en cada tick). */
  enabledWhen?: (state: string) => boolean
}

const MENU_ITEMS: MenuItem[] = [
  { id: 1, label: APP_NAME, action: undefined, enabledWhen: () => false },
  { id: 2, label: "Estado: …", action: undefined, enabledWhen: () => false },
  { id: 3, separator: true },
  { id: 10, label: "Iniciar servidor", action: "start", enabledWhen: (s) => s !== "running" && s !== "starting" },
  { id: 11, label: "Detener servidor", action: "stop", enabledWhen: (s) => s === "running" },
  { id: 12, label: "Reiniciar servidor", action: "restart", enabledWhen: (s) => s === "running" },
  { id: 4, separator: true },
  { id: 20, label: "Configurar…", action: "configure" },
  { id: 21, label: "Abrir Panel (" + PANEL_URL.replace("http://", "") + ")", action: "panel" },
  { id: 22, label: "Ver credenciales", action: "credentials" },
  { id: 23, label: "Carpeta de datos", action: "datadir" },
  { id: 24, label: "Ver registros (logs)", action: "logs" },
  { id: 5, separator: true },
  { id: 30, label: "Salir (cierra solo la bandeja; el servidor sigue)", action: "quit" },
]

function menuLabel(item: MenuItem, state: string): string | undefined {
  if (item.separator) return undefined
  if (item.id === 2) return STATE_LABEL[state] ?? state
  return item.label
}

function menuEnabled(item: MenuItem, state: string): boolean {
  if (item.separator) return false
  if (!item.enabledWhen) return true
  return item.enabledWhen(state)
}

// ---------------------------------------------------------------------------
// Estado del servicio (systemctl — sin DBus privilegiado, como la bandeja
// de Windows usa sc.exe: el estado REAL lo pregunta al sistema)
// ---------------------------------------------------------------------------

function serviceState(): string {
  try {
    const r = spawnSync(SYSTEMCTL, ["is-active", SERVICE], {
      encoding: "utf8",
      timeout: 5000,
    })
    if (r.error) return "missing"
    const out = (r.stdout ?? "").trim().toLowerCase()
    if (r.status === 0 && out === "active") return "running"
    if (out === "activating" || out === "reloading" || out === "auto-restart") return "starting"
    if (out === "deactivating") return "stopping"
    if (out === "not-found" || r.status === 4) return "missing"
    return "stopped"
  } catch {
    return "missing"
  }
}

// ---------------------------------------------------------------------------
// Acciones (spawn DESACOPLADO — la bandeja nunca espera a systemctl)
// ---------------------------------------------------------------------------

function runDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch (e) {
    console.error(`viewlba-tray: no se pudo lanzar ${cmd}:`, (e as Error).message)
  }
}

function serviceAction(verb: string): void {
  runDetached(PKEXEC, [SYSTEMCTL, verb, TARGET])
  // sondeo rápido mientras el estado cambia (1 s durante 45 s)
  fastUntil = Date.now() + 45_000
}

function openUrl(url: string): void {
  runDetached(OPENER, [url])
}

function openPath(path: string): void {
  if (existsSync(path)) {
    openUrl("file://" + path)
  }
}

// ---------------------------------------------------------------------------
// Notificaciones (org.freedesktop.Notifications — globo del escritorio)
// ---------------------------------------------------------------------------

let notifyConn: DBusConnection | null = null

async function notify(icon: string, title: string, body: string): Promise<void> {
  if (!notifyConn) return
  try {
    await notifyConn.call(NOTIFICATIONS, "/org/freedesktop/Notifications", NOTIFICATIONS, "Notify", "susssasa{sv}i", [
      APP_NAME,
      0, // replaces_id
      icon,
      title,
      body,
      [], // actions
      [], // hints (a{sv})
      5000, // timeout ms
    ], { timeoutMs: 3000 })
  } catch (e) {
    // sin demonio de notificaciones (o timeout) — la bandeja sigue perfecta.
    // Se registra en stderr para diagnóstico (no es un error del servidor).
    console.error(`viewlba-tray: notificación no entregada (${(e as Error).message})`)
  }
}

// ---------------------------------------------------------------------------
// Instancia única (pid-file — autostart + lanzamiento manual no duplican)
// ---------------------------------------------------------------------------

function pidFile(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || "/tmp"
  return `${runtime}/viewlba-tray-${process.getuid?.() ?? 0}.pid`
}

function acquireSingleInstance(): boolean {
  const file = pidFile()
  try {
    const other = Number(readFileSync(file, "utf8").trim())
    if (other > 0 && other !== process.pid) {
      // ¿Sigue vivo Y es la bandeja? (un pid reutilizado por otro proceso NO cuenta)
      try {
        process.kill(other, 0)
        const cmdline = readFileSync(`/proc/${other}/cmdline`, "utf8")
        if (cmdline.includes("tray.ts")) {
          console.error(`viewlba-tray: ya hay una instancia corriendo (pid ${other}).`)
          return false
        }
      } catch {
        // pid muerto → archivo huérfano: lo reemplazamos abajo
      }
    }
  } catch {
    // sin archivo → primera instancia
  }
  try {
    writeFileSync(file, String(process.pid), { mode: 0o644 })
  } catch {
    // sin XDG_RUNTIME_DIR escribible → seguir SIN protección (mejor bandeja
    // duplicada que bandeja ausente)
  }
  return true
}

function releasePidFile(): void {
  try {
    const file = pidFile()
    if (Number(readFileSync(file, "utf8").trim()) === process.pid) unlinkSync(file)
  } catch {
    // nada
  }
}

// ---------------------------------------------------------------------------
// Modo --check (verificación SIN GUI — lo usan el CI y el diagnóstico manual)
// ---------------------------------------------------------------------------

function selfCheck(): number {
  const critical: Record<string, boolean> = {
    script: typeof Bun !== "undefined" && typeof Bun.main === "string",
    "service-unit": existsSync(`/etc/systemd/system/${SERVICE}`),
    "cli-wrapper": existsSync("/usr/bin/viewlba-server"),
    "runtime-bun": existsSync("/opt/viewlba-server/runtime/bun"),
    "tray-source": existsSync("/opt/viewlba-server/tray/tray.ts"),
  }
  const info: Record<string, boolean> = {
    "display": Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    "dbus-session": Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
  }
  const ok = Object.values(critical).every(Boolean)
  console.log("viewlba-tray --check:")
  for (const [k, v] of Object.entries(critical)) {
    console.log(`  ${k.padEnd(14)} ${v ? "OK" : "NO (CRÍTICO)"}`)
  }
  for (const [k, v] of Object.entries(info)) {
    console.log(`  ${k.padEnd(14)} ${v ? "OK" : "NO (informativo — bandeja de escritorio)"}`)
  }
  return ok ? 0 : 1
}

// ---------------------------------------------------------------------------
// Tray (SNI + DBusMenu + notificaciones sobre la conexión real)
// ---------------------------------------------------------------------------

let conn: DBusConnection
let state = "stopped"
let revision = 1
let fastUntil = 0
let watcherOk = false
let busName = ""
let exiting = false

function currentIcon(): string {
  return ICON_BY_STATE[state] ?? "viewlba"
}

/** Layout DBusMenu de un ítem (o de la raíz si id === 0). */
function layoutNode(id: number): unknown {
  if (id === 0) {
    return [
      0,
      [["children-display", new Variant("s", "submenu")]],
      MENU_ITEMS.map((m) => new Variant("(ia{sv}av)", layoutNode(m.id))),
    ]
  }
  const item = MENU_ITEMS.find((m) => m.id === id)
  if (!item) return [id, [], []]
  const props: Array<[string, Variant]> = []
  if (item.separator) {
    props.push(["type", new Variant("s", "separator")])
  } else {
    props.push(["type", new Variant("s", "standard")])
    props.push(["label", new Variant("s", menuLabel(item, state) ?? "")])
    props.push(["enabled", new Variant("b", menuEnabled(item, state))])
    props.push(["visible", new Variant("b", true)])
  }
  return [id, props, []]
}

function exportMenu(): void {
  conn.exportObject(MENU_PATH, {
    [MENU_IFACE]: {
      methods: {
        GetLayout: {
          in: "iias",
          out: "u(ia{sv}av)",
          handler: (args) => {
            const parentId = args[0] as number
            if (parentId !== 0 && !MENU_ITEMS.some((m) => m.id === parentId)) {
              throw new DBusError("org.freedesktop.DBus.Error.InvalidArgs", `parentId no encontrado: ${parentId}`)
            }
            return [revision, layoutNode(parentId)]
          },
        },
        GetGroupProperties: {
          in: "aias",
          out: "a(ia{sv})",
          handler: (args) => {
            const ids = args[0] as number[]
            const out: Array<[number, Array<[string, Variant]>]> = []
            for (const m of MENU_ITEMS) {
              if (ids.length > 0 && !ids.includes(m.id)) continue
              const node = layoutNode(m.id) as [number, Array<[string, Variant]>, unknown]
              out.push([m.id, node[1]])
            }
            return [out]
          },
        },
        GetProperty: {
          in: "is",
          out: "v",
          handler: (args) => {
            const [id, name] = args as [number, string]
            const node = layoutNode(id) as [number, Array<[string, Variant]>, unknown]
            const found = node[1].find(([k]) => k === name)
            if (!found) throw new DBusError("org.freedesktop.DBus.Error.InvalidArgs", `propiedad ${name} no encontrada en ${id}`)
            return [found[1]]
          },
        },
        Event: {
          in: "isvu",
          handler: (args) => {
            const [id, eventId] = args as [number, string]
            if (eventId === "clicked") onMenuClick(id)
            return []
          },
        },
        EventGroup: {
          in: "a(isvu)",
          out: "ai",
          handler: (args) => {
            const events = args[0] as Array<[number, string, Variant, number]>
            const notFound: number[] = []
            for (const [id, eventId] of events) {
              if (eventId === "clicked" && MENU_ITEMS.some((m) => m.id === id)) onMenuClick(id)
              else notFound.push(id)
            }
            return [notFound]
          },
        },
        AboutToShow: {
          in: "i",
          out: "b",
          handler: (args) => {
            // refrescar el estado AHORA (el usuario va a ver el menú)
            tick()
            // false = no hacía falta LayoutUpdated (enfoque Qt/libdbusmenu)
            return [false]
          },
        },
        AboutToShowGroup: {
          in: "ai",
          out: "aiai",
          handler: (args) => {
            const ids = args[0] as number[]
            const notFound = ids.filter((id) => !MENU_ITEMS.some((m) => m.id === id))
            return [[], notFound]
          },
        },
      },
      properties: {
        Version: { sig: "u", get: () => 3 },
        TextDirection: { sig: "s", get: () => "ltr" },
        Status: { sig: "s", get: () => "normal" },
        IconThemePath: { sig: "as", get: () => [] },
      },
      signals: {
        ItemsPropertiesUpdated: { sig: "a(ia{sv})a(ias)" },
        LayoutUpdated: { sig: "ui" },
        ItemActivationRequested: { sig: "iu" },
      },
    },
  })
}

function exportSni(): void {
  conn.exportObject(SNI_PATH, {
    [SNI_IFACE]: {
      methods: {
        ContextMenu: {
          in: "ii",
          handler: () => {
            // los hosts modernos usan la propiedad Menu — no dibujamos menú a mano
            throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", "ContextMenu no soportado (usar la propiedad Menu)")
          },
        },
        Activate: {
          in: "ii",
          handler: () => {
            // clic izquierdo → abrir el Panel (toda la configuración vive ahí)
            openUrl(PANEL_URL)
            return []
          },
        },
        SecondaryActivate: {
          in: "ii",
          handler: () => {
            openUrl(PANEL_URL)
            return []
          },
        },
        Scroll: {
          in: "is",
          handler: () => [],
        },
      },
      properties: {
        Category: { sig: "s", get: () => "ApplicationStatus" },
        Id: { sig: "s", get: () => "viewlba-tray" },
        Title: { sig: "s", get: () => APP_NAME },
        Status: { sig: "s", get: () => "Active" },
        WindowId: { sig: "i", get: () => 0 },
        IconThemePath: { sig: "s", get: () => "" },
        Menu: { sig: "o", get: () => MENU_PATH },
        ItemIsMenu: { sig: "b", get: () => false },
        IconName: { sig: "s", get: () => currentIcon() },
        IconPixmap: { sig: "a(iiay)", get: () => [] },
        OverlayIconName: { sig: "s", get: () => "" },
        OverlayIconPixmap: { sig: "a(iiay)", get: () => [] },
        AttentionIconName: { sig: "s", get: () => "" },
        AttentionIconPixmap: { sig: "a(iiay)", get: () => [] },
        AttentionMovieName: { sig: "s", get: () => "" },
        ToolTip: {
          sig: "(sa(iiay)ss)",
          get: () => [currentIcon(), [], APP_NAME, STATE_TIP[state] ?? state],
        },
      },
      signals: {
        NewTitle: { sig: "" },
        NewIcon: { sig: "" },
        NewAttentionIcon: { sig: "" },
        NewOverlayIcon: { sig: "" },
        NewToolTip: { sig: "" },
        NewStatus: { sig: "s" },
      },
    },
  })
}

function onMenuClick(id: number): void {
  const item = MENU_ITEMS.find((m) => m.id === id)
  if (!item?.action) return
  switch (item.action) {
    case "start":
      serviceAction("start")
      break
    case "stop":
      serviceAction("stop")
      break
    case "restart":
      serviceAction("restart")
      break
    case "configure":
    case "panel":
      openUrl(PANEL_URL)
      break
    case "credentials":
      openPath(CRED_FILE)
      break
    case "datadir":
      openPath(DATA_DIR)
      break
    case "logs":
      openPath(LOG_DIR)
      break
    case "quit":
      shutdown(0)
      break
  }
}

/** Menú actualizado (etiquetas + sensibilidad) → señales DBusMenu. */
function pushMenuUpdate(): void {
  revision++
  conn.signal(MENU_PATH, MENU_IFACE, "LayoutUpdated", "ui", [revision, 0])
  const updated: Array<[number, Array<[string, Variant]>]> = []
  for (const m of MENU_ITEMS) {
    if (m.separator) continue
    const node = layoutNode(m.id) as [number, Array<[string, Variant]>, unknown]
    updated.push([m.id, node[1]])
  }
  conn.signal(MENU_PATH, MENU_IFACE, "ItemsPropertiesUpdated", "a(ia{sv})a(ias)", [updated, []])
}

/** Estado del servidor cambiado → icono + tooltip + notificación. */
function pushStateUpdate(oldState: string): void {
  conn.signal(SNI_PATH, SNI_IFACE, "NewIcon", "", [])
  conn.signal(SNI_PATH, SNI_IFACE, "NewToolTip", "", [])
  pushMenuUpdate()
  if (oldState !== state && (state === "running" || state === "stopped") && oldState !== "missing") {
    if (state === "running") {
      void notify(currentIcon(), "Servidor ViewLBA EN EJECUCIÓN", `El panel está disponible en ${PANEL_URL}`)
    } else {
      void notify(currentIcon(), "Servidor ViewLBA DETENIDO", "Clic derecho en la bandeja para iniciarlo de nuevo.")
    }
  }
}

// ---------------------------------------------------------------------------
// Registro en el host StatusNotifier (con re-registro si el watcher vuelve)
// ---------------------------------------------------------------------------

async function registerWithWatcher(): Promise<boolean> {
  try {
    // ¿hay watcher? (GetNameOwner falla con NameHasNoOwner si no)
    await conn.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", [WATCHER], { timeoutMs: 3000 })
    await conn.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem", "s", [busName], { timeoutMs: 5000 })
    watcherOk = true
    return true
  } catch {
    watcherOk = false
    return false
  }
}

function watchWatcherRestarts(): void {
  conn.onSignal((s) => {
    if (s.iface === "org.freedesktop.DBus" && s.member === "NameOwnerChanged" && s.args[0] === WATCHER) {
      const newOwner = String(s.args[2] ?? "")
      if (newOwner) void registerWithWatcher()
    }
  })
  // LA LECCIÓN del primer e2e: el dbus-daemon SOLO entrega las señales con
  // match rule — sin esto, la bandeja jamás se enteraba de que el watcher
  // (re)aparecía y no se re-registraba.
  void conn.addMatch(
    "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.kde.StatusNotifierWatcher'",
  )
}

// ---------------------------------------------------------------------------
// Tick: sondeo del estado + actualizaciones
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (exiting) return
  const old = state
  state = serviceState()
  if (old !== state) {
    pushStateUpdate(old)
  }
  // re-registro si el watcher nunca apareció (o murió): un intento por tick
  // (GetNameOwner falla rápido cuando no hay watcher — barato y determinista)
  if (!watcherOk) {
    void registerWithWatcher()
  }
}

function scheduleTick(): void {
  const interval = Date.now() < fastUntil ? FAST_TICK_MS : TICK_MS
  setTimeout(() => {
    void tick().finally(scheduleTick)
  }, interval)
}

// keepalive: si el bus muere, la bandeja muere con él (el autostart la trae
// de vuelta en el próximo login) — detectarlo temprano evita una bandeja
// zombi sin icono.
function schedulePing(): void {
  setTimeout(() => {
    conn
      .call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.Peer", "Ping", "", [], { timeoutMs: 5000 })
      .catch(() => shutdown(1))
      .finally(schedulePing)
  }, 55_000)
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

let exitCode: number | null = null

function shutdown(code: number): void {
  if (exitCode !== null) return
  exitCode = code
  try {
    conn.close()
  } catch {
    // ya estaba cerrada
  }
  releasePidFile()
  process.exit(code)
}

async function main(): Promise<number> {
  if (process.argv.includes("--check")) return selfCheck()

  // Sin escritorio → mensaje claro y salida limpia (no romper nada).
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error(
      "viewlba-tray: sin sesión gráfica (DISPLAY/WAYLAND_DISPLAY) — " +
        "la bandeja necesita un escritorio; el servidor sigue corriendo.",
    )
    return 0
  }

  if (!acquireSingleInstance()) return 0

  try {
    conn = await DBusConnection.connect()
    await conn.hello()
  } catch (e) {
    console.error(
      "viewlba-tray: no hay bus de sesión D-Bus (" + (e as Error).message + ") — " +
        "la bandeja necesita un escritorio con sesión gráfica; el servidor sigue corriendo.",
    )
    return 0
  }
  notifyConn = conn

  conn.onDisconnect(() => {
    // bus perdido (logout): salir limpio — el autostart la relanza
    shutdown(1)
  })

  busName = `org.kde.StatusNotifierItem-${process.pid}-1`
  await conn.requestName(busName)
  exportSni()
  exportMenu()
  watchWatcherRestarts()
  await registerWithWatcher()

  state = serviceState()

  // bienvenida (si hay demonio de notificaciones)
  notify(currentIcon(), "Bandeja de ViewLBA activa", `Servidor: ${STATE_LABEL[state] ?? state}. Menú: clic derecho en el icono.`)

  // bun-types no declara las señales de node:process en on(); el runtime
  // (bun, que es quien ejecuta la bandeja) las acepta tal cual.
  process.on("SIGTERM" as never, () => shutdown(0))
  process.on("SIGINT" as never, () => shutdown(0))

  scheduleTick()
  schedulePing()

  // mantener el proceso vivo hasta shutdown()
  await new Promise<void>(() => {})
  return 0
}

main().then(
  (code) => {
    releasePidFile()
    process.exit(code)
  },
  (err) => {
    console.error("viewlba-tray: error fatal:", err)
    releasePidFile()
    process.exit(1)
  },
)
