/**
 * UI interactiva de terminal — los 12 pasos de la misión.
 *
 * REUTILIZA scripts/lib/prompt (readline con ciclo de vida correcto:
 * close+unref+watchdog — ver FASE 31) y los checks de preflight existentes.
 * La LÓGICA vive en installer/core; aquí SOLO se pregunta y se muestra.
 */
import { ask, askPassword, closeStdin } from "../../scripts/lib/prompt"
import type { CheckResult, InstallConfig, InstallMode } from "../core/types"
import { DEFAULT_CONFIG } from "../core/types"
import { normalizeConfig } from "../core/config"
import { detectExisting, describeExisting } from "../core/existing"
import { renderDiagnostic } from "../core/diagnostics"
import type { DiagnosticBlock } from "../core/types"
import type { ServiceAdapter } from "../core/adapter"
import { resolveLayout } from "../core/layout"
import { lanIp, suggestSubnet } from "../core/sysinfo"

const OK = (s: string) => console.log(`✓ ${s}`)
const INFO = (s: string) => console.log(`· ${s}`)
const WARN = (s: string) => console.log(`⚠ ${s}`)
const FAIL = (s: string) => console.error(`✗ ${s}`)
const STEP = (s: string) => console.log(`\n→ ${s}`)

/** Paso 1: bienvenida. */
export function welcome(): void {
  console.log(`
============================================================
  ViewLBA Server — Installer oficial
  Señalización digital para restaurantes · 100% LAN
============================================================
Este asistente instala y configura TODO el servidor:
aplicación, base de datos, servicios 24/7, firewall y health.
`)
}

/** Paso 2: mostrar preflight (checks con PASS/WARNING/FAIL). */
export function showChecks(checks: CheckResult[]): void {
  for (const c of checks) {
    const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"
    const line = `${icon} ${c.label}`
    const extra = c.status === "pass" ? "" : `${c.detail ? ` — ${c.detail}` : ""}${c.hint ? `\n    ↳ ${c.hint}` : ""}`
    if (c.status === "fail") console.error(line + extra)
    else console.log(line + extra)
  }
}

/** Paso 3: detección de instalación previa + elección de modo. */
export async function askMode(adapter: ServiceAdapter, installDir?: string): Promise<{ mode: InstallMode; existing: ReturnType<typeof detectExisting> }> {
  const layout = resolveLayout(adapter.platform, installDir ? { installDir } : {})
  const existing = detectExisting(layout, { detectServices: (l) => adapter.detectExistingServices(l) })
  if (existing.suggestedMode === "new") {
    STEP("3/12 — Directorio de instalación")
    INFO(`Destino: ${layout.appDir}`)
    INFO(`Datos:   ${layout.dataDir}`)
    INFO(`Logs:    ${layout.logDir}`)
    const dir = (await ask(`Directorio [${layout.appDir}]: `)).trim()
    if (dir && dir !== layout.appDir) {
      const layout2 = resolveLayout(adapter.platform, { installDir: dir })
      INFO(`Destino personalizado: ${layout2.appDir} · datos: ${layout2.dataDir}`)
      const recheck = detectExisting(layout2, { detectServices: (l) => adapter.detectExistingServices(l) })
      return { mode: await confirmMode("new", recheck), existing: recheck }
    }
    return { mode: "new", existing }
  }

  console.log("\nSe detectó una instalación previa:")
  for (const line of describeExisting(existing)) INFO(line)
  return { mode: await confirmMode(existing.suggestedMode, existing), existing }
}

async function confirmMode(suggested: InstallMode, existing: ReturnType<typeof detectExisting>): Promise<InstallMode> {
  if (existing.suggestedMode === "new") return "new"
  console.log("\n  [1] Nueva instalación     (ignora la existente — NO borra datos)")
  console.log("  [2] Actualizar instalación (código nuevo, datos y .env intactos)")
  console.log("  [3] Reparar instalación    (reinstala servicios/entorno, datos intactos)")
  const def = suggested === "update" ? "2" : "3"
  for (;;) {
    const answer = (await ask(`Elige [${def}]: `)).trim() || def
    if (answer === "1") return "new"
    if (answer === "2") return "update"
    if (answer === "3") return "repair"
    WARN("Responde 1, 2 o 3.")
  }
}

/** Pasos 4-5: configuración básica y red (los presets de flags NO se preguntan). */
export async function askConfig(
  platform: "linux" | "windows",
  defaults: Partial<InstallConfig> = {},
  presets: Partial<InstallConfig> = {}
): Promise<InstallConfig> {
  STEP("4/12 — Configuración básica")
  const name =
    presets.restaurantName !== undefined
      ? presets.restaurantName
      : (await ask(`Nombre del restaurante [${defaults.restaurantName ?? DEFAULT_CONFIG.restaurantName}]: `)).trim() ||
        defaults.restaurantName ||
        DEFAULT_CONFIG.restaurantName
  const tz =
    presets.timezone !== undefined
      ? presets.timezone
      : (await ask(`Zona horaria [${defaults.timezone ?? DEFAULT_CONFIG.timezone}]: `)).trim() ||
        defaults.timezone ||
        DEFAULT_CONFIG.timezone
  const webPort = Number(
    presets.webPort !== undefined
      ? presets.webPort
      : (await ask(`Puerto web (app) [${defaults.webPort ?? DEFAULT_CONFIG.webPort}]: `)).trim() ||
          defaults.webPort ||
          DEFAULT_CONFIG.webPort
  )
  const realtimePort = Number(
    presets.realtimePort !== undefined
      ? presets.realtimePort
      : (await ask(`Puerto realtime (socket.io) [${defaults.realtimePort ?? DEFAULT_CONFIG.realtimePort}]: `)).trim() ||
          defaults.realtimePort ||
          DEFAULT_CONFIG.realtimePort
  )
  const rtmpPort = Number(
    presets.rtmpPort !== undefined
      ? presets.rtmpPort
      : (await ask(`Puerto RTMP (OBS) [${defaults.rtmpPort ?? DEFAULT_CONFIG.rtmpPort}]: `)).trim() ||
          defaults.rtmpPort ||
          DEFAULT_CONFIG.rtmpPort
  )

  STEP("5/12 — Red")
  const ip = lanIp()
  const detectedSubnet = suggestSubnet(ip)
  const lanMode =
    presets.lanMode !== undefined
      ? presets.lanMode
      : ((await ask(`¿Modo LAN (servir a TVs de la red)? [S/n]: `)).trim().toLowerCase() || "s") !== "n"
  let lanSubnet: string | undefined
  if (lanMode) {
    if (detectedSubnet) INFO(`Red detectada: ${ip} (${detectedSubnet})`)
    lanSubnet =
      presets.lanSubnet !== undefined
        ? presets.lanSubnet
        : (await ask(`Subred para firewall [${detectedSubnet ?? "192.168.1.0/24"}]: `)).trim() ||
          (detectedSubnet ?? "192.168.1.0/24")
  }
  const offline =
    presets.offline !== undefined
      ? presets.offline
      : ((await ask(`¿Instalación completamente offline (payload sin red)? [s/N]: `)).trim().toLowerCase() || "n") === "s"

  return normalizeConfig(
    {
      ...defaults,
      ...presets,
      restaurantName: name,
      timezone: tz,
      webPort,
      realtimePort,
      rtmpPort,
      lanMode,
      lanSubnet,
      offline,
    },
    ip
  )
}

/** Pasos 6-7: secrets y DB (informativos — la core lo hace). */
export function announceSecretsAndDb(): void {
  STEP("6/12 — Secretos")
  INFO("Se generan con crypto del runtime (AUTH_SECRET/REALTIME_TOKEN) y NO se imprimen.")
  INFO("Si ya existe un .env, se respeta TODO (solo se añaden los faltantes).")
  STEP("7/12 — Base de datos")
  INFO("SQLite en el directorio de datos · migraciones versionadas (migrate deploy).")
  INFO("Protección de DB objetivo: se VERIFICA el datasource real antes de migrar.")
}

/** Paso 11: credenciales del primer admin (flags → prompts → omitir). */
export async function askAdmin(presets: { email?: string; password?: string; demo?: boolean } = {}): Promise<{ email?: string; password?: string; demo: boolean }> {
  STEP("11/12 — Primer administrador")
  let email = presets.email
  if (!email) {
    email = (await ask("Email del administrador (Enter para omitir y crearlo luego): ")).trim().toLowerCase() || undefined
  }
  let password = presets.password
  if (email && !password) {
    if (process.stdin.isTTY === true) {
      for (;;) {
        const pw = await askPassword("Contraseña del administrador: ")
        const pw2 = await askPassword("Confirmar contraseña: ")
        if (pw === pw2) {
          password = pw
          break
        }
        WARN("Las contraseñas no coinciden — reintenta.")
      }
    } else {
      password = (await ask("Contraseña del administrador: ")).trim() || undefined
    }
  }
  const demo =
    presets.demo !== undefined
      ? presets.demo
      : ((await ask("¿Sembrar contenido demo (promos/platos/horarios)? [s/N]: ")).trim().toLowerCase() || "n") === "s"
  return { email, password, demo }
}

/** Paso 12: final. */
export function showReport(report: { ok: boolean; urls: { admin: string; tv: string; health: string; rtmp: string }; warnings: string[]; durationMs: number }): void {
  if (report.ok) {
    console.log(`
============================================================
  ✅ INSTALACIÓN COMPLETA (${(report.durationMs / 1000).toFixed(0)}s)
============================================================
  Panel de administración:  ${report.urls.admin}
  Pantalla TV:               ${report.urls.tv}
  Health:                    ${report.urls.health}
  RTMP (OBS):                ${report.urls.rtmp}  · clave desde el panel

  Las TVs abren la URL de arriba; el panel la URL de admin.
============================================================`)
    if (report.warnings.length > 0) {
      console.log("Advertencias durante la instalación:")
      for (const w of report.warnings) WARN(`  · ${w}`)
    }
  }
}

export function showDiagnostic(d: DiagnosticBlock): void {
  console.error("\n" + renderDiagnostic(d))
}

/** Confirmación de desinstalación con casillas (texto). */
export async function askUninstall(): Promise<{ removeApplication: boolean; removeServices: boolean; removeConfig: boolean; removeMedia: boolean; removeBackups: boolean; removeDatabase: boolean }> {
  console.log("\nDesinstalación — los datos se CONSERVAN por defecto:")
  const yn = async (label: string, def: string): Promise<boolean> => {
    const a = (await ask(`${label} [${def}]: `)).trim().toLowerCase() || def
    return a === "s" || a === "si" || a === "sí"
  }
  return {
    removeApplication: await yn("[ ] Aplicación (código)", "s"),
    removeServices: await yn("[ ] Servicios del sistema", "s"),
    removeConfig: await yn("[ ] Configuración (.env)", "s"),
    removeMedia: await yn("[ ] Medios (IMÁGENES — se pierden)", "n"),
    removeBackups: await yn("[ ] Backups", "n"),
    removeDatabase: await yn("[ ] BASE DE DATOS (TODO el contenido)", "n"),
  }
}

export { OK, INFO, WARN, FAIL, STEP }
