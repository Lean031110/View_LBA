/**
 * CLI oficial del installer de ViewLBA Server (entrada única).
 *
 * Modos:
 *   · interactivo (terminal, 12 pasos)  → `viewlba-installer` / `install`
 *   · GUI sidecar (NDJSON)              → `--json` (Tauri lo spawnea)
 *   · unattended (config JSON)          → `--config archivo.json`
 *
 * Manager (post-instalación):
 *   preflight · admin · services start|stop|restart|status · health · logs ·
 *   backup · restore <db> · update <payload> · repair · uninstall · diagnostics
 *
 * Protocolo de finalización (bug readline/stdin de Bun, FASE 31):
 * exit NATURAL con process.exitCode; process.exit SOLO como watchdog que
 * deja log. Cero lógica de negocio aquí: core/adapters la tienen.
 *
 * Uso: bun installer/cli/main.ts [comando|flags]
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dlopen } from "bun:ffi"
import { ask, askPassword, closeStdin } from "../../scripts/lib/prompt"
import { initializeProduction } from "../../scripts/lib/production-init"
import { readEnvFile } from "../../scripts/lib/env-file"
import { runInstall, resolvePackageRoot, checkExisting } from "../core/install"
import { resolveNssm } from "../windows/adapter"
import { resolveLayout } from "../core/layout"
import { normalizeConfig } from "../core/config"
import { runPreflight } from "../core/preflight"
import { RecordingRunner, RealRunner } from "../core/runner"
import type { InstallConfig } from "../core/types"
import { LinuxServiceAdapter } from "../linux/adapter"
import { WindowsServiceAdapter } from "../windows/adapter"
import * as ui from "./ui"
import { detectExisting } from "../core/existing"
import { jsonEventSink, readGuiMessage, asGuiMessage, humanLog } from "./protocol"
import {
  findInstallation,
  managerContext,
  servicesAction,
  healthAction,
  backupAction,
  restoreAction,
  updateAction,
  repairAction,
  diagnosticsAction,
  logsAction,
  uninstallAction,
  tailFile,
  DEFAULT_UNINSTALL,
} from "../core/manager"

const argv = process.argv.slice(2)
const flags = new Set(argv.map((a) => a.split("=")[0]))

// Flags con valor en DOS formas: --flag=valor y --flag valor (estándar).
// La forma ESPACIO es la que usan postinst (Linux) y el NSIS (Windows):
// `--config "$PKG/install-config.json"`. Sin soporte (bug real v3.2.0),
// el camino quedaba como SUBCOMANDO desconocido → printHelp + exit 1 y
// el postinst abortaba la instalación.
const arg = (name: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return undefined
  const a = argv[i]
  if (a.startsWith(`--${name}=`)) return a.split("=").slice(1).join("=")
  const next = argv[i + 1]
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

// Flags que SÍ consumen el argumento siguiente como VALOR (forma espacio).
// NO incluir flags booleanos (--json, --confirm, --demo…): consumirían el
// SUBCOMANDO siguiente (bug de regresión: «--json detect» perdía «detect»
// y el CLI caía en modo instalación sidecar esperando config por stdin).
const VALUE_FLAGS = new Set(["--config", "--dir", "--email", "--password", "--uninstall-options"])

// Posiciones consumidas como VALOR de un flag en forma espacio (para no
// confundirlas con un subcomando: `--config cfg.json` → «cfg.json» NO es
// subcomando, pero `--json detect` → «detect» SÍ es subcomando).
const flagValueIdx = new Set<number>()
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    flagValueIdx.add(i + 1)
  }
}
const subcommand =
  argv.find((a, i) => !a.startsWith("--") && !a.includes("=") && !flagValueIdx.has(i)) ?? "install"

const JSON_MODE = flags.has("--json")
const CONFIG_FILE = arg("config")

/** CLI humano: logs a consola; modo --json: stdout reservado al protocolo. */
const log = JSON_MODE ? humanLog : console.log

function detectPlatform(): "linux" | "windows" {
  if (process.platform === "win32") return "windows"
  return "linux"
}

/**
 * Adapter con dependencias del PAQUETE resueltas (nssm incluido en el
 * payload de Windows: sin esto, preflight falla en una máquina limpia).
 */
function adapterFor(platform: "linux" | "windows", packageRoot = resolvePackageRoot()): LinuxServiceAdapter | WindowsServiceAdapter {
  return platform === "linux"
    ? new LinuxServiceAdapter()
    : new WindowsServiceAdapter(resolveNssm(packageRoot))
}

// ---------------------------------------------------------------- install
async function interactiveInstall(): Promise<number> {
  ui.welcome()

  const platform = detectPlatform()
  const adapter = adapterFor(platform)
  const installDir = arg("dir")

  // Flags de compatibilidad (misma superficie que scripts/install.ts):
  // lo que viene por flag NO se pregunta.
  const presets: Partial<InstallConfig> = {}
  const email = arg("email")
  const password = arg("password")
  if (arg("port")) presets.webPort = Number(arg("port"))
  if (arg("timezone")) presets.timezone = arg("timezone")
  if (flags.has("--no-build")) presets.runBuild = false
  if (flags.has("--offline")) presets.offline = true
  const demoFlag = flags.has("--demo") ? true : flags.has("--no-demo") ? false : undefined

  // Paso 2: preflight temprano (solo lectura) para pantalla 1.
  ui.STEP("2/12 — Preflight")
  const { mode } = await ui.askMode(adapter, installDir)
  const config0 = await ui.askConfig(platform, { mode, installDir }, presets)
  ui.announceSecretsAndDb()

  const { email: e2, password: p2, demo } = await ui.askAdmin({ email, password, demo: demoFlag })
  const config: InstallConfig = { ...config0, adminEmail: e2, adminPassword: p2, withDemoData: demo }

  // Preflight REAL (bloqueante ante FAIL) con la config elegida.
  const layout = resolveLayout(platform, config)
  const pre = await runPreflight(config, layout, {
    runner: new RealRunner(),
    platform,
    platformChecks: adapter.checkPlatform(),
    ownBusyPorts: new Set<number>(),
  })
  ui.showChecks(pre.checks)
  if (pre.blocking) {
    console.error("\n✗ Hay comprobaciones FAIL críticas: NO se puede continuar (nada se ha modificado).")
    return 1
  }

  const report = await runInstall(config, {
    adapter,
    emit: (e) => {
      if (e.type === "phase-start") ui.STEP(`${e.phase}`)
      if (e.type === "phase-end") log(`  ${e.status === "ok" ? "✓" : e.status === "warn" ? "⚠" : "✗"} ${e.phase}${e.detail ? ` — ${e.detail}` : ""}`)
      if (e.type === "check") {
        const c = e.result
        log(`  ${c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"} ${c.label}${c.status !== "pass" && c.detail ? ` — ${c.detail}` : ""}`)
      }
      if (e.type === "warn") log(`  ⚠ ${e.message}`)
      if (e.type === "info") log(`  · ${e.message}`)
    },
  })

  if (!report.ok && report.diagnostic) {
    ui.showDiagnostic(report.diagnostic)
    if (report.rollback) {
      console.log("Rollback no destructivo aplicado:")
      for (const n of report.rollback.notes) console.log(`  · ${n}`)
      for (const k of report.rollback.kept) console.log(`  · CONSERVADO: ${k}`)
    }
    return 1
  }
  ui.showReport(report)
  return 0
}

async function jsonInstall(): Promise<number> {
  // GUI sidecar: espera {"type":"config",...} por stdin y emite NDJSON.
  const sink = jsonEventSink()
  sink({ type: "info", message: "waiting-config" })
  humanLog("[installer] esperando config de la GUI por stdin…")
  const msg = asGuiMessage(await readGuiMessage(300_000))
  if (!msg || msg.type !== "config") {
    sink({ type: "failed", diagnostic: { phase: "preflight", error: "La GUI no envió la configuración", suggestion: "Reinicia el asistente." } })
    return 1
  }
  const platform = detectPlatform()
  const adapter = adapterFor(platform)
  const config = normalizeConfig((msg.config ?? {}) as Partial<InstallConfig>, undefined)
  const report = await runInstall(config, { adapter, emit: sink })
  void report
  return report.ok ? 0 : 1
}

async function unattendedInstall(configFile: string): Promise<number> {
  if (!existsSync(configFile)) {
    console.error(`✗ No existe el archivo de configuración ${configFile}`)
    return 1
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>
  } catch (e) {
    console.error(`✗ JSON inválido en ${configFile}: ${(e as Error).message}`)
    return 1
  }
  const platform = detectPlatform()
  const adapter = adapterFor(platform)
  const config = normalizeConfig(raw as Partial<InstallConfig>, undefined)
  const report = await runInstall(config, { adapter, emit: (e) => {
    if (e.type === "phase-start") console.log(`\n→ ${e.phase}: ${e.title}`)
    if (e.type === "phase-end") console.log(`  ${e.phase}: ${e.status}${e.detail ? ` — ${e.detail}` : ""}`)
    if (e.type === "check" && e.result.status !== "pass") console.log(`  ⚠/✗ ${e.result.label}`)
  } })
  if (!report.ok && report.diagnostic) ui.showDiagnostic(report.diagnostic)
  else if (report.ok) ui.showReport(report)
  return report.ok ? 0 : 1
}

const KNOWN_MANAGER_COMMANDS = [
  "preflight",
  "admin",
  "services",
  "health",
  "logs",
  "backup",
  "restore",
  "update",
  "repair",
  "diagnostics",
  "uninstall",
  "detect",
] as const

// ---------------------------------------------------------------- manager (JSON para la GUI)
/** Igual que runManager pero serializa el resultado a stdout (GUI sidecar). */
async function runManagerJson(cmd: string): Promise<number> {
  const platform = detectPlatform()
  const adapter = adapterFor(platform)
  const out = (payload: unknown, code = 0): number => {
    process.stdout.write(JSON.stringify({ ok: code === 0, command: cmd, result: payload }) + "\n")
    return code
  }
  if (!KNOWN_MANAGER_COMMANDS.includes(cmd as (typeof KNOWN_MANAGER_COMMANDS)[number])) {
    return out({ error: `comando desconocido: ${cmd}` }, 1)
  }
  const { layout, found } = findInstallation(platform, arg("dir"))
  if (!found && !["preflight", "update", "repair", "detect"].includes(cmd)) {
    return out({ error: `No hay instalación de ViewLBA en ${layout.appDir}` }, 1)
  }
  const ctx = managerContext(platform, adapter, arg("dir"))

  try {
    switch (cmd) {
      case "detect": {
        // Detección de instalación previa para la GUI (misma lógica que el CLI).
        const existing = detectExisting(layout, { detectServices: (l) => adapter.detectExistingServices(l) })
        return out({
          found,
          layout: { appDir: layout.appDir, dataDir: layout.dataDir, logDir: layout.logDir, envFile: layout.envFile },
          existing: { envFile: existing.envFile, hasApp: existing.hasApp, hasDatabase: existing.hasDatabase, services: existing.services, suggestedMode: existing.suggestedMode },
        })
      }
      case "preflight": {
        const config = normalizeConfig({ mode: "new" }, undefined)
        const pre = await runPreflight(config, layout, {
          runner: new RealRunner(),
          platform,
          platformChecks: adapter.checkPlatform(),
        })
        return out({ checks: pre.checks, blocking: pre.blocking }, pre.blocking ? 1 : 0)
      }
      case "services": {
        const action = (argv[1] ?? "status") as "start" | "stop" | "restart" | "status"
        return out({ statuses: await servicesAction(ctx, adapter, action) })
      }
      case "health": {
        return out(await healthAction(ctx, { timeoutMs: 10_000 }), 0)
      }
      case "logs": {
        const { paths, hint } = logsAction(ctx, adapter)
        return out({ paths, hint, tail: tailFile(paths[0] ?? "", 80) })
      }
      case "backup": {
        const r = await backupAction(ctx, adapter)
        return out({ ok: r.ok, output: r.output.slice(0, 4000), error: r.error }, r.ok ? 0 : 1)
      }
      case "diagnostics": {
        return out(await diagnosticsAction(ctx, adapter))
      }
      case "uninstall": {
        const opts = arg("uninstall-options")
        let options = DEFAULT_UNINSTALL
        if (opts) {
          options = { ...DEFAULT_UNINSTALL, ...(JSON.parse(opts) as Record<string, boolean>) }
        }
        const confirm = flags.has("--confirm") || Boolean(opts)
        const r = await uninstallAction(ctx, adapter, options, confirm)
        return out(r)
      }
      case "restore": {
        const file = argv[1]
        if (!file || !existsSync(resolve(file))) return out({ error: `archivo inexistente: ${file ?? ""}` }, 1)
        const r = await restoreAction(ctx, adapter, resolve(file))
        return out({ ok: r.ok, output: r.output.slice(0, 4000) }, r.ok ? 0 : 1)
      }
      case "update": {
        const payload = argv[1]
        if (!payload || !existsSync(resolve(payload))) return out({ error: `payload inexistente: ${payload ?? ""}` }, 1)
        const report = await updateAction(platform, adapter, ctx.config, resolve(payload))
        return out(report, report.ok ? 0 : 1)
      }
      case "repair": {
        const report = await repairAction(platform, adapter, ctx.config)
        return out(report, report.ok ? 0 : 1)
      }
      case "admin": {
        const email = arg("email")
        const password = arg("password")
        if (!email || !password) return out({ error: "--email y --password requeridos en modo --json" }, 1)
        const fileEnv = readEnvFile(layout.envFile) ?? {}
        const r = await initializeProduction({
          envFile: layout.envFile,
          databaseUrl: fileEnv.DATABASE_URL,
          adminEmail: email,
          adminPassword: password,
          healthChecks: false,
          skipMigrations: true,
        })
        return out({ ok: r.ok, steps: r.steps, adminCreated: r.adminCreated }, r.ok ? 0 : 1)
      }
      default:
        return out({ error: "no implementado en JSON" }, 1)
    }
  } catch (e) {
    return out({ error: (e as Error).message }, 1)
  }
}

// ---------------------------------------------------------------- manager (humano)
async function runManager(cmd: string): Promise<number> {
  if (!KNOWN_MANAGER_COMMANDS.includes(cmd as (typeof KNOWN_MANAGER_COMMANDS)[number])) {
    printHelp()
    return 1
  }
  const platform = detectPlatform()
  const adapter = adapterFor(platform)
  const { layout, found } = findInstallation(platform, arg("dir"))
  if (!found && !["preflight", "update", "repair", "detect"].includes(cmd)) {
    console.error(`✗ No hay instalación de ViewLBA en ${layout.appDir} (¿instalar primero?)`)
    return 1
  }
  const ctx = managerContext(platform, adapter, arg("dir"))

  switch (cmd) {
    case "preflight": {
      const config = normalizeConfig({ mode: "new" }, undefined)
      const pre = await runPreflight(config, layout, {
        runner: new RealRunner(),
        platform,
        platformChecks: adapter.checkPlatform(),
      })
      ui.showChecks(pre.checks)
      return pre.blocking ? 1 : 0
    }

    case "admin": {
      const email = arg("email") ?? (await ask("Email del administrador: ")).trim().toLowerCase()
      const password = arg("password") ?? (await askPassword("Contraseña: "))
      const envFile = layout.envFile
      const fileEnv = readEnvFile(envFile) ?? {}
      const r = await initializeProduction({
        envFile,
        databaseUrl: fileEnv.DATABASE_URL,
        adminEmail: email || undefined,
        adminPassword: password || undefined,
        healthChecks: false,
        skipMigrations: true,
      })
      for (const s of r.steps) console.log(`  ${s.status === "ok" ? "✓" : "○"} ${s.name}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`)
      return r.ok ? 0 : 1
    }

    case "services": {
      const action = (argv[1] ?? "status") as "start" | "stop" | "restart" | "status"
      const statuses = await servicesAction(ctx, adapter, action)
      for (const s of statuses) {
        console.log(`${s.active ? "✓ activo" : s.enabled ? "○ parado (auto)" : "✗ inactivo"}  ${s.name}`)
      }
      return 0
    }

    case "health": {
      const report = await healthAction(ctx, { timeoutMs: 10_000 })
      ui.showChecks([
        { id: "status", label: `Estado global: ${report.status}`, status: report.ok ? "pass" : report.status === "degraded" ? "warn" : "fail" },
      ])
      return report.ok ? 0 : 1
    }

    case "logs": {
      const { paths, hint } = logsAction(ctx, adapter)
      console.log(`Logs: ${paths.join(", ")}`)
      console.log(`Seguimiento: ${hint}`)
      for (const p of paths.slice(0, 1)) {
        const tail = tailFile(p, 40)
        if (tail.length > 0) {
          console.log(`\n--- últimas líneas de ${p} ---`)
          for (const l of tail) console.log(l)
        }
      }
      return 0
    }

    case "backup": {
      const r = await backupAction(ctx, adapter)
      console.log(r.output || (r.ok ? "✓ backup completado" : ""))
      if (!r.ok && r.error) console.error(r.error)
      return r.ok ? 0 : 1
    }

    case "restore": {
      const file = argv[1]
      if (!file) {
        console.error("Uso: viewlba-installer restore <ruta/al/backup.db>")
        return 1
      }
      const confirm = flags.has("--confirm")
      if (!confirm) {
        console.log(`⚠ Restaurar REEMPLAZA la DB activa (se detienen los servicios).`)
        console.log(`  Se guarda copia pre-restore. Añade --confirm para proceder.`)
        return 1
      }
      const r = await restoreAction(ctx, adapter, resolve(file))
      console.log(r.output)
      return r.ok ? 0 : 1
    }

    case "update": {
      const payload = argv[1]
      if (!payload || !existsSync(resolve(payload))) {
        console.error("Uso: viewlba-installer update <ruta/al/payload-nuevo>")
        return 1
      }
      const fileEnv = readEnvFile(layout.envFile) ?? {}
      const config = normalizeConfig(
        {
          mode: "update",
          webPort: Number(fileEnv.PORT ?? 3000),
          realtimePort: Number(fileEnv.REALTIME_PORT ?? 3003),
          rtmpPort: Number(fileEnv.RTMP_PORT ?? 1935),
          httpFlvPort: Number(fileEnv.HTTP_FLV_PORT ?? 8000),
          timezone: fileEnv.TIMEZONE ?? "America/Havana",
          payloadDir: resolve(payload),
          withDemoData: false,
          offline: false,
          runBuild: true,
        },
        undefined
      )
      const report = await updateAction(platform, adapter, config, resolve(payload))
      if (report.ok) ui.showReport(report)
      else if (report.diagnostic) ui.showDiagnostic(report.diagnostic)
      return report.ok ? 0 : 1
    }

    case "repair": {
      const report = await repairAction(platform, adapter, ctx.config)
      if (report.ok) ui.showReport(report)
      else if (report.diagnostic) ui.showDiagnostic(report.diagnostic)
      return report.ok ? 0 : 1
    }

    case "diagnostics": {
      const d = await diagnosticsAction(ctx, adapter)
      ui.showChecks(d.checks)
      console.log("\nServicios:")
      for (const s of d.services) console.log(`${s.active ? "✓" : "✗"} ${s.name}`)
      console.log(`\nSugerencia de logs: ${adapter.logsHint(ctx)}`)
      return d.health.ok ? 0 : 1
    }

    case "uninstall": {
      const opts = arg("uninstall-options") // JSON desde GUI
      let options = DEFAULT_UNINSTALL
      if (opts) {
        try {
          options = { ...DEFAULT_UNINSTALL, ...(JSON.parse(opts) as Record<string, boolean>) }
        } catch {
          console.error("✗ --uninstall-options debe ser JSON válido")
          return 1
        }
      } else {
        options = await ui.askUninstall()
      }
      const confirm = flags.has("--confirm") || Boolean(opts)
      const r = await uninstallAction(ctx, adapter, options, confirm)
      console.log(r.ran ? "Desinstalación:" : "Desinstalación cancelada:")
      for (const rmItem of r.removed) console.log(`  ✗ ELIMINADO: ${rmItem}`)
      for (const k of r.kept) console.log(`  ✓ CONSERVADO: ${k}`)
      for (const w of r.warnings) console.log(`  ⚠ ${w}`)
      return 0
    }

    default:
      printHelp()
      return 1
  }
}

function printHelp(): void {
  console.log(`
ViewLBA Server Installer — uso:

  viewlba-installer                      instalación interactiva (12 pasos)
  viewlba-installer --config cfg.json    instalación desatendida
  viewlba-installer --json               modo sidecar GUI (protocolo NDJSON)

Gestión (tras instalar):
  preflight | admin | services <start|stop|restart|status> | health |
  logs | backup | restore <db> --confirm | update <payload> | repair |
  diagnostics | uninstall [--confirm] [--uninstall-options JSON]

Flags: --dir=<installdir> · --email= · --password= · --demo/--no-demo
`)
}

// ---------------------------------------------------------------- main
async function main(): Promise<number> {
  if (JSON_MODE) {
    // --json con subcomando de gestión → resultado JSON único;
    // sin subcomando → instalación sidecar con eventos NDJSON.
    if (subcommand !== "install") return runManagerJson(subcommand)
    return jsonInstall()
  }
  if (CONFIG_FILE) return unattendedInstall(CONFIG_FILE)
  if (subcommand === "install") return interactiveInstall()
  return runManager(subcommand)
}

// ---------- Protocolo de finalización ----------
// ⚠⚠ SALIDA A NIVEL DE SO (bugs reales del 15.º-16.º build, Windows): el
// sidecar completaba TODA la instalación (migraciones, servicio Running,
// health ok, reporte impreso) pero el PROCESO nunca terminaba:
//   · 15.º build: exit natural + watchdog unref de 6 s → el timer NUNCA
//     disparó → cadena cmd /c → NSIS → Setup.exe colgada 20+ min.
//   · 16.º build: process.exit() tras «await setTimeout(300)» → colgado
//     IGUAL (bun-compile/Windows: los handles nativos del árbol
//     bun→prisma→schema-engine impiden la salida a nivel de JS).
// La cadena completa espera a ESTE proceso: la ÚNICA salida garantizada
// es a nivel de SISTEMA OPERATIVO (nada de event loop, nada de handles):
//   · Windows: kernel32.ExitProcess vía FFI (terminación inmediata).
//   · POSIX:   process.exit (comportamiento correcto comprobado: .deb,
//     AppImage y CLI completan y salen con su código).
// La gracia de 200 ms es SÍNCRONA (Atomics.wait): NO depende del event
// loop — un setTimeout JAMÁS dispararía con el loop colgado (16.º build).
main()
  .then((code) => {
    process.exitCode = code
    closeStdin()
    syncSleep(200) // vaciar el stdout (pipe de cmd /c) SIN event loop
    osExit(code)
  })
  .catch((e) => {
    console.error("\n✗ Error:", (e as Error).message)
    process.exitCode = 1
    closeStdin()
    syncSleep(200)
    osExit(1)
  })

/** Sueño SÍNCRONO sin event loop (Atomics.wait). Sin SharedArrayBuffer:
 * sin gracia — la salida es inmediata de todos modos. */
function syncSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* sin Atomics.wait: omitir la gracia */
  }
}

/**
 * Salida INMEDIATA a nivel de sistema operativo. En Windows usa
 * kernel32.ExitProcess vía FFI (bun:ffi) — ni el event loop ni los
 * handles colgados pueden impedirla. Fallback: process.exit (correcto
 * en POSIX; en Windows es el último recurso si FFI no está disponible).
 */
function osExit(code: number): never {
  if (process.platform === "win32") {
    try {
      const k32 = dlopen("kernel32", {
        ExitProcess: { args: ["uint32"], returns: "void" },
      })
      ;(k32.symbols.ExitProcess as (c: number) => void)(code)
    } catch {
      /* sin FFI → process.exit abajo */
    }
  }
  process.exit(code)
  throw new Error("inalcanzable: osExit")
}

// Exportado para tests del protocolo (spawn de este archivo).
export { checkExisting, RecordingRunner }
