/**
 * MODO GESTIÓN (Server Manager) — lo que queda tras la instalación.
 *
 * REUTILIZA la semántica de deploy/linux/manage.sh y deploy/windows/manage.ps1:
 *   services · health · logs · backup · restore · update · repair · uninstall
 * y ejecuta el TRABAJO REAL con los scripts EXISTENTES del servidor
 * (scripts/backup.ts, scripts/restore.ts) como subprocesos — el installer
 * NO re-implementa backup/restore.
 *
 * Uninstall: nunca borra datos por defecto (misión).
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CheckResult, EventSink, HealthReport, InstallConfig, Layout, ServiceStatus } from "./types"
import { resolveLayout } from "./layout"
import { readEnvFile } from "../../scripts/lib/env-file"
import { waitForHealth, probeService, healthChecks } from "./health"
import { buildDiagnostic, renderDiagnostic } from "./diagnostics"
import { runInstall } from "./install"
import type { ServiceAdapter, InstallContext } from "./adapter"
import { RollbackRegistry } from "./rollback"
import { RealRunner, type CmdRunner } from "./runner"
import { normalizeConfig } from "./config"

export interface UninstallOptions {
  /** Qué quitar (todo lo demás se CONSERVA). Datos: opt-in explícito. */
  removeApplication: boolean
  removeServices: boolean
  removeConfig: boolean
  removeMedia: boolean
  removeBackups: boolean
  removeDatabase: boolean
}

export const DEFAULT_UNINSTALL: UninstallOptions = {
  removeApplication: true,
  removeServices: true,
  removeConfig: true,
  removeMedia: false,
  removeBackups: false,
  removeDatabase: false,
}

/** Localiza una instalación existente y su layout (para el Manager). */
export function findInstallation(platform: "linux" | "windows", installDir?: string): { layout: Layout; found: boolean } {
  const layout = resolveLayout(platform, installDir ? { installDir } : {})
  const found = existsSync(layout.envFile) || existsSync(join(layout.appDir, "package.json"))
  return { layout, found }
}

/** Contexto de gestión sobre una instalación detectada. */
export function managerContext(
  platform: "linux" | "windows",
  adapter: ServiceAdapter,
  installDir?: string,
  runner: CmdRunner = new RealRunner()
): InstallContext {
  const { layout } = findInstallation(platform, installDir)
  const fileEnv = readEnvFile(layout.envFile) ?? {}
  return {
    config: normalizeConfig({
      webPort: Number(fileEnv.PORT ?? 3000),
      realtimePort: Number(fileEnv.REALTIME_PORT ?? 3003),
      rtmpPort: Number(fileEnv.RTMP_PORT ?? 1935),
      httpFlvPort: Number(fileEnv.HTTP_FLV_PORT ?? 8000),
      mode: "repair",
    }),
    layout,
    runner,
    emit: () => {},
    registry: new RollbackRegistry(),
    env: { ...process.env, ...fileEnv, NODE_ENV: "production" },
    bunPath: process.env.VIEWLBA_BUN ?? "bun",
  }
}

// ---------- acciones del Manager ----------

export async function servicesAction(ctx: InstallContext, adapter: ServiceAdapter, action: "start" | "stop" | "restart" | "status"): Promise<ServiceStatus[]> {
  if (action === "start") await adapter.startAll(ctx)
  if (action === "stop") await adapter.stopAll(ctx)
  if (action === "restart") await adapter.restartAll(ctx)
  return adapter.statusAll(ctx)
}

export async function healthAction(ctx: InstallContext, opts: { timeoutMs?: number } = {}): Promise<HealthReport> {
  const port = Number(ctx.env.PORT ?? ctx.config.webPort ?? 3000)
  const report = await waitForHealth(
    {
      app: `http://127.0.0.1:${port}/api/health`,
      realtime: "http://127.0.0.1:3004/health",
      stream: "http://127.0.0.1:8100/health",
    },
    { timeoutMs: opts.timeoutMs ?? 10_000 }
  )
  return report
}

/** Backup: REUTILIZA scripts/backup.ts del servidor instalado (subproceso). */
export async function backupAction(ctx: InstallContext, adapter: ServiceAdapter): Promise<{ ok: boolean; output: string; error?: string }> {
  const script = join(ctx.layout.appDir, "scripts", "backup.ts")
  if (!existsSync(script)) return { ok: false, output: "", error: `No se encuentra ${script} — ¿instalación completa?` }
  const r = ctx.runner.run(ctx.bunPath, ["scripts/backup.ts"], {
    cwd: ctx.layout.appDir,
    env: ctx.env,
    timeoutMs: 300_000,
    runAsUser: adapter.platform === "linux" ? ctx.layout.serviceUser ?? undefined : undefined,
  })
  return { ok: r.status === 0, output: r.stdout + r.stderr, error: r.status === 0 ? undefined : renderDiagnostic(buildDiagnostic({ phase: "manager", area: "backup", error: r.stderr.slice(0, 400) || "backup falló" })) }
}

/** Restore: detiene → restaura (scripts/restore.ts) → arranca (manage.sh igual). */
export async function restoreAction(
  ctx: InstallContext,
  adapter: ServiceAdapter,
  backupFile: string
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!existsSync(backupFile)) return { ok: false, output: "", error: `No existe ${backupFile}` }
  await adapter.stopAll(ctx)
  const r = ctx.runner.run(ctx.bunPath, ["scripts/restore.ts", "--file", backupFile, "--confirm"], {
    cwd: ctx.layout.appDir,
    env: ctx.env,
    timeoutMs: 300_000,
    runAsUser: adapter.platform === "linux" ? ctx.layout.serviceUser ?? undefined : undefined,
  })
  await adapter.startAll(ctx)
  return { ok: r.status === 0, output: r.stdout + r.stderr }
}

/** Update: instala desde un payload nuevo (modo update — datos intactos). */
export async function updateAction(
  platform: "linux" | "windows",
  adapter: ServiceAdapter,
  config: InstallConfig,
  payloadDir: string,
  emit?: EventSink
): Promise<ReturnType<typeof runInstall>> {
  return runInstall({ ...config, mode: "update", payloadDir }, { adapter, emit })
}

/** Repair: reinstala servicios/entorno conservando TODO (modo repair). */
export async function repairAction(
  platform: "linux" | "windows",
  adapter: ServiceAdapter,
  config: InstallConfig,
  emit?: EventSink
): Promise<ReturnType<typeof runInstall>> {
  return runInstall({ ...config, mode: "repair" }, { adapter, emit })
}

/** Diagnóstico del sistema instalado (health + servicios + entorno). */
export async function diagnosticsAction(ctx: InstallContext, adapter: ServiceAdapter): Promise<{ health: HealthReport; services: ServiceStatus[]; checks: CheckResult[] }> {
  const health = await healthAction(ctx, { timeoutMs: 5000 })
  const services = await adapter.statusAll(ctx)
  const checks = healthChecks(health)
  checks.push({
    id: "env-file",
    label: `Entorno: ${ctx.layout.envFile}`,
    status: existsSync(ctx.layout.envFile) ? "pass" : "fail",
  })
  return { health, services, checks }
}

/** Logs (rutas + hint del adapter; el tail lo hace la UI/terminal). */
export function logsAction(ctx: InstallContext, adapter: ServiceAdapter): { paths: string[]; hint: string } {
  return { paths: adapter.logPaths(ctx), hint: adapter.logsHint(ctx) }
}

/**
 * UNINSTALL con casillas (misión): nunca borra datos automáticamente.
 * Devuelve un informe de lo eliminado y lo conservado.
 */
export async function uninstallAction(
  ctx: InstallContext,
  adapter: ServiceAdapter,
  options: UninstallOptions,
  confirm: boolean
): Promise<{ ran: boolean; removed: string[]; kept: string[]; warnings: string[] }> {
  const removed: string[] = []
  const kept: string[] = []
  const warnings: string[] = []

  if (!confirm) {
    return { ran: false, removed, kept: ["(sin cambios: falta confirmación)"], warnings: ["La desinstalación requiere confirmación explícita"] }
  }
  if (!options.removeApplication && !options.removeServices && !options.removeConfig) {
    return { ran: false, removed, kept: ["(sin cambios: nada seleccionado)"], warnings: ["No se seleccionó ningún componente para quitar"] }
  }

  // 1) Servicios SIEMPRE primero (no dejar servicios apuntando a archivos borrados).
  if (options.removeServices) {
    try {
      await adapter.removeServices(ctx)
      removed.push("servicios del sistema")
    } catch (e) {
      warnings.push(`No se pudieron quitar los servicios: ${(e as Error).message} — quítalos a mano (manage.sh/manage.ps1)`)
      kept.push("servicios del sistema")
    }
  } else {
    kept.push("servicios del sistema (siguen instalados)")
  }

  // 2) Datos: SOLO con opt-in explícito.
  const dataTargets: Array<[boolean, string, string]> = [
    [options.removeDatabase, "base de datos", ctx.layout.dbFile],
    [options.removeMedia, "medios", ctx.layout.mediaDir],
    [options.removeBackups, "backups", ctx.layout.backupDir],
  ]
  for (const [opt, label, path] of dataTargets) {
    if (opt) {
      if (!existsSync(path)) {
        kept.push(`${label} (no existía)`)
        continue
      }
      try {
        if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true })
        else rmSync(path)
        removed.push(`${label} (${path}) — ELIMINADO A PETICIÓN`)
      } catch (e) {
        warnings.push(`No se pudo eliminar ${label}: ${(e as Error).message}`)
        kept.push(`${label} (${path})`)
      }
    } else {
      kept.push(`${label} — CONSERVADO (${path})`)
    }
  }

  // 3) Configuración (.env).
  if (options.removeConfig && existsSync(ctx.layout.envFile)) {
    try {
      rmSync(ctx.layout.envFile)
      removed.push(`configuración (${ctx.layout.envFile})`)
    } catch (e) {
      warnings.push(`No se pudo borrar el .env: ${(e as Error).message}`)
    }
  } else if (!options.removeConfig) {
    kept.push(`configuración (${ctx.layout.envFile})`)
  }

  // 4) Aplicación (código) — al final, y SOLO el directorio de código.
  if (options.removeApplication) {
    try {
      if (existsSync(ctx.layout.appDir)) rmSync(ctx.layout.appDir, { recursive: true, force: true })
      removed.push(`aplicación (${ctx.layout.appDir})`)
    } catch (e) {
      warnings.push(`No se pudo borrar ${ctx.layout.appDir}: ${(e as Error).message} (¿archivos en uso? detén los servicios primero)`)
    }
  } else {
    kept.push(`aplicación (${ctx.layout.appDir})`)
  }

  return { ran: true, removed, kept, warnings }
}

/** Lee las últimas líneas de un log (para la GUI/CLI sin depender de tail). */
export function tailFile(path: string, maxLines = 50): string[] {
  try {
    if (!existsSync(path)) return []
    const content = readFileSync(path, "utf8")
    return content.split(/\r?\n/).slice(-maxLines).filter((l) => l.length > 0)
  } catch {
    return []
  }
}
