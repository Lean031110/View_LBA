/**
 * ORQUESTADOR de la instalación oficial de ViewLBA Server.
 *
 * Pipeline de fases (arquitectura §3) sobre ServiceAdapter + CmdRunner.
 * REUTILIZA (no reimplementa):
 *  - scripts/lib/production-init.ts → initializeProduction() para las fases
 *    database y admin (incluye la VERIFICACIÓN REAL del target de DB y el
 *    abort por mismatch — protección anti "otra base de datos");
 *  - scripts/lib/env-file.ts para leer el .env como fuente de verdad;
 *  - secrets.ts (semántica extraída de scripts/install.ts) para el .env;
 *  - /api/health para la validación final.
 *
 * Rollback NO destructivo (rollback.ts) ante cualquier fallo de fase.
 * Sin stdin, sin process.exit: la UI (CLI/GUI) decide cómo terminar.
 */
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { initializeProduction } from "../../scripts/lib/production-init"
import { readEnvFile, detectEnvContamination } from "../../scripts/lib/env-file"
import type {
  CheckResult,
  DiagnosticBlock,
  EventSink,
  InstallConfig,
  InstallReport,
  InstallPhase,
  Layout,
} from "./types"
import { PHASE_TITLES } from "./types"
import { resolveLayout, layoutDirs } from "./layout"
import { ensureDir, copyDirFiltered, copyTree } from "./fsx"
import { ensureEnvFile } from "./secrets"
import { detectExisting } from "./existing"
import { runPreflight, payloadHasDeps } from "./preflight"
import { waitForHealth, healthChecks } from "./health"
import { RollbackRegistry, performRollback } from "./rollback"
import { buildDiagnostic } from "./diagnostics"
import type { ServiceAdapter, InstallContext } from "./adapter"
import { RealRunner, type CmdRunner } from "./runner"
import { configToEnvEntries, validateConfig } from "./config"

export interface InstallDeps {
  adapter: ServiceAdapter
  runner?: CmdRunner
  emit?: EventSink
  /** Para tests: initializeProduction inyectable. */
  initProd?: typeof initializeProduction
  /** Para tests: waitForHealth inyectable. */
  waitHealth?: typeof waitForHealth
  /** Timeout del health final. */
  healthTimeoutMs?: number
  /** Raíz del paquete (payload + runtime); default: auto-detección. */
  packageRoot?: string
}

export class PhaseError extends Error {
  constructor(
    readonly phase: InstallPhase,
    message: string,
    readonly command?: string,
    readonly logPath?: string,
    readonly area?: string,
    readonly affectedFile?: string
  ) {
    super(message)
  }
}

/** Localiza el payload (código del servidor a instalar). */
export function resolvePayloadDir(config: InstallConfig, packageRoot: string): string {
  if (config.payloadDir) return resolve(config.payloadDir)
  for (const cand of [join(packageRoot, "resources", "server"), join(packageRoot, "server")]) {
    if (existsSync(join(cand, "package.json"))) return cand
  }
  return packageRoot // repo checkout: el propio repo es el payload
}

/**
 * Raíz del paquete: si el installer corre desde el repo → raíz del repo;
 * si corre como binario empaquetado → carpeta con resources/ y runtime/.
 */
export function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // installer/core
  const repoRoot = resolve(here, "..", "..")
  if (existsSync(join(repoRoot, "package.json")) && existsSync(join(repoRoot, "src", "app"))) {
    return repoRoot // checkout del servidor
  }
  return dirname(process.argv[1] ?? process.argv[0] ?? ".")
}

/** Binario bun incluido en el paquete (runtime/bun), si existe. */
export function findBundledBun(packageRoot: string): string | undefined {
  for (const p of [
    join(packageRoot, "runtime", "bun"),
    join(packageRoot, "runtime", "bun.exe"),
    join(packageRoot, "resources", "runtime", "bun"),
  ]) {
    if (existsSync(p)) return p
  }
  return undefined
}

/** Detecta la instalación previa (antes de modificar nada). */
export function checkExisting(config: InstallConfig, layout: Layout, adapter: ServiceAdapter) {
  return detectExisting(layout, { detectServices: (l) => adapter.detectExistingServices(l) })
}

export async function runInstall(config: InstallConfig, deps: InstallDeps): Promise<InstallReport> {
  const t0 = Date.now()
  const runner = deps.runner ?? new RealRunner()
  const emit: EventSink = deps.emit ?? (() => {})
  const adapter = deps.adapter
  const layout = resolveLayout(adapter.platform, config)
  const checks: CheckResult[] = []
  const warnings: string[] = []
  const registry = new RollbackRegistry()
  const initProd = deps.initProd ?? initializeProduction
  const waitHealth = deps.waitHealth ?? waitForHealth
  const packageRoot = deps.packageRoot ?? resolvePackageRoot()

  // ---------- 0) Validación de config (antes de TODO) ----------
  const issues = validateConfig(config)
  if (issues.length > 0) {
    const diagnostic: DiagnosticBlock = {
      phase: "preflight",
      error: `Configuración inválida:\n${issues.map((i) => `  · ${i.field}: ${i.message}`).join("\n")}`,
      suggestion: "Corrige los campos indicados en el asistente antes de continuar.",
    }
    return {
      ok: false,
      mode: config.mode,
      layout,
      checks,
      warnings,
      urls: emptyUrls(),
      adminCreated: false,
      diagnostic,
      durationMs: Date.now() - t0,
    }
  }

  const bundledBun = findBundledBun(packageRoot)
  const ctx: InstallContext = {
    config,
    layout,
    runner,
    emit,
    registry,
    env: { ...process.env },
    bunPath: bundledBun ?? process.env.VIEWLBA_BUN ?? "bun",
  }
  // Bun incluido: que bunx/bun de initializeProduction resuelvan al del paquete.
  if (bundledBun) {
    const runtimeDir = dirname(bundledBun)
    ctx.env.PATH = `${runtimeDir}${ctx.env.PATH ? `:${ctx.env.PATH}` : ""}`
    process.env.PATH = ctx.env.PATH
  }

  const phase = async (p: InstallPhase, fn: () => Promise<void | string>): Promise<void> => {
    emit({ type: "phase-start", phase: p, title: PHASE_TITLES[p] })
    try {
      const detail = await fn()
      emit({ type: "phase-end", phase: p, status: "ok", detail: detail ?? undefined })
    } catch (e) {
      const pe = e instanceof PhaseError ? e : new PhaseError(p, (e as Error).message)
      emit({ type: "phase-end", phase: p, status: "fail", detail: pe.message })
      throw pe
    }
  }

  let healthReport: InstallReport["health"]
  let adminCreated = false

  try {
    // ============================================================ preflight
    await phase("preflight", async () => {
      const existing = checkExisting(config, layout, adapter)
      // Puertos propios ocupados (modo update/repair): los servicios ya corren.
      const ownPorts = new Set<number>()
      if (existing.services.some((s) => s.active)) {
        ownPorts.add(config.webPort)
        ownPorts.add(config.realtimePort)
        ownPorts.add(config.rtmpPort)
        ownPorts.add(config.httpFlvPort)
      }
      const payloadDir = resolvePayloadDir(config, packageRoot)
      const report = await runPreflight(config, layout, {
        runner,
        platform: adapter.platform,
        platformChecks: adapter.checkPlatform(),
        ownBusyPorts: ownPorts,
        bundledBun,
        offlinePayload: config.offline ? payloadHasDeps(payloadDir) : undefined,
      })
      checks.push(...report.checks)
      for (const c of report.checks) {
        emit({ type: "check", result: c })
        if (c.status === "warn" && c.hint) warnings.push(`${c.label} — ${c.hint}`)
        if (c.status === "fail") {
          throw new PhaseError(
            "preflight",
            `${c.label}${c.detail ? `: ${c.detail}` : ""}${c.hint ? ` — ${c.hint}` : ""}`,
            undefined,
            undefined,
            c.id
          )
        }
      }
      if (existing.suggestedMode === "new" && config.mode !== "new") {
        warnings.push("No se detectó instalación previa pero se pidió actualizar/reparar — se procede como instalación nueva")
      }
      return `${report.checks.length} comprobaciones`
    })

    // ============================================================ deploy
    await phase("deploy", async () => {
      const payloadDir = resolvePayloadDir(config, packageRoot)
      if (!existsSync(join(payloadDir, "package.json"))) {
        throw new PhaseError("deploy", `Payload inválido: no hay package.json en ${payloadDir}`, undefined, undefined, "payload")
      }

      // Árbol de directorios (solo se registra como "creado" lo nuevo).
      for (const dir of [layout.appDir, ...layoutDirs(layout)]) {
        const wasNew = !existsSync(dir)
        ensureDir(dir)
        if (wasNew) registry.markDirCreated(dir)
      }

      if (config.mode === "update") {
        emit({ type: "info", message: "Modo actualizar: el código se sincroniza; los DATOS no se tocan" })
      }

      // Copia del servidor → appDir (exclusiones estándar; nunca datos).
      const copied = copyDirFiltered(payloadDir, layout.appDir)
      emit({ type: "progress", current: copied, total: copied, label: "archivos copiados" })

      // Payload offline (o con deps vendored): node_modules incluidos.
      const payloadOffline = payloadHasDeps(payloadDir)
      if (payloadOffline) {
        copyTree(join(payloadDir, "node_modules"), join(layout.appDir, "node_modules"))
        emit({ type: "info", message: "node_modules incluidos en el paquete (instalación sin red)" })
        for (const svc of ["realtime-service", "stream-service"]) {
          const ms = join(payloadDir, "mini-services", svc, "node_modules")
          if (existsSync(ms)) copyTree(ms, join(layout.appDir, "mini-services", svc, "node_modules"))
        }
      }

      if (!payloadOffline) {
        if (config.offline) {
          throw new PhaseError(
            "deploy",
            "Instalación offline pero el payload NO incluye node_modules",
            undefined,
            undefined,
            "offline-payload"
          )
        }
        // Instalación con red: dependencias reproducibles.
        const install = runner.run(ctx.bunPath, ["install", "--frozen-lockfile"], { cwd: layout.appDir, timeoutMs: 600_000 })
        if (install.status !== 0) {
          emit({ type: "warn", message: "--frozen-lockfile falló; reintentando con resolución normal" })
          const retry = runner.run(ctx.bunPath, ["install"], { cwd: layout.appDir, timeoutMs: 600_000 })
          if (retry.status !== 0) {
            throw new PhaseError("deploy", `bun install falló: ${(retry.stderr || retry.stdout).slice(0, 400)}`, retry.command, undefined, "deps")
          }
        }
        for (const svc of ["realtime-service", "stream-service"]) {
          const dir = join(layout.appDir, "mini-services", svc)
          const r = runner.run(ctx.bunPath, ["install", "--frozen-lockfile"], { cwd: dir, timeoutMs: 300_000 })
          if (r.status !== 0) {
            const r2 = runner.run(ctx.bunPath, ["install"], { cwd: dir, timeoutMs: 300_000 })
            if (r2.status !== 0) {
              throw new PhaseError("deploy", `bun install falló en ${svc}: ${(r2.stderr || r2.stdout).slice(0, 300)}`, r2.command, undefined, "deps")
            }
          }
        }
      }

      // Prisma Client (necesario para migrate y para el runtime).
      const gen = runner.run(ctx.bunPath, ["x", "prisma", "generate"], { cwd: layout.appDir, timeoutMs: 240_000 })
      if (gen.status !== 0) {
        throw new PhaseError("deploy", `prisma generate falló: ${(gen.stderr || gen.stdout).slice(0, 400)}`, gen.command, undefined, "prisma")
      }
      return `${copied} archivos → ${layout.appDir}`
    })

    // ============================================================ environment
    await phase("environment", async () => {
      if (existsSync(layout.envFile)) registry.markEnvFilePreExisting()
      const res = ensureEnvFile(config, layout)
      if (res.created) registry.markEnvFileCreated(layout.envFile)
      if (res.added.length > 0) {
        emit({ type: "info", message: `.env incompleto — añadidos (sin imprimir valores): ${res.added.join(", ")}` })
      }

      // Entorno para procesos hijos: .env como fuente de verdad local.
      const fileEnv = readEnvFile(layout.envFile) ?? {}
      const contamination = detectEnvContamination(fileEnv)
      if (contamination) {
        warnings.push(contamination)
        emit({ type: "warn", message: contamination })
      }
      ctx.env = { ...process.env, ...fileEnv }
      // Instalación NUEVA: los valores del wizard mandan (puertos, dirs, tz).
      if (config.mode === "new") {
        for (const [k, v] of configToEnvEntries(config, layout)) ctx.env[k] = v
      }
      ctx.env.DATABASE_URL = fileEnv.DATABASE_URL ?? layout.dbUrl
      ctx.env.NODE_ENV = "production"
      return res.created ? ".env generado con secretos aleatorios (crypto)" : ".env existente respetado (solo faltantes añadidos)"
    })

    // ============================================================ database
    await phase("database", async () => {
      // REUTILIZA initializeProduction: valida el entorno, VERIFICA el target
      // real de la DB (abort por mismatch) y aplica migrate deploy.
      const result = await initProd({
        envFile: layout.envFile,
        databaseUrl: ctx.env.DATABASE_URL,
        withDemoData: config.withDemoData,
        healthChecks: false, // la fase health lo hace con los servicios arriba
        skipMigrations: false,
      })
      for (const s of result.steps) emit({ type: "check", result: stepToCheck(s) })
      if (!result.ok) {
        throw new PhaseError("database", result.error ?? "inicialización de DB fallida", undefined, undefined, "database")
      }
      return "migraciones aplicadas (migrate deploy)"
    })

    // ============================================================ services
    await phase("services", async () => {
      await adapter.installServices(ctx)
      return "servicios instalados y arrancados (stream → realtime → app)"
    })

    // ============================================================ firewall
    await phase("firewall", async () => {
      const fw = await adapter.configureFirewall(ctx)
      checks.push(...fw)
      for (const c of fw) {
        emit({ type: "check", result: c })
        if (c.status === "warn" && c.hint) warnings.push(`${c.label} — ${c.hint}`)
      }
      // El firewall nunca aborta la instalación (warn documentado).
      return fw.length > 0 ? `${fw.filter((c) => c.status === "pass").length}/${fw.length} reglas aplicadas` : "sin gestor de firewall (documentado)"
    })

    // ============================================================ health
    await phase("health", async () => {
      const endpoints = {
        app: `http://127.0.0.1:${config.webPort}/api/health`,
        realtime: "http://127.0.0.1:3004/health",
        stream: "http://127.0.0.1:8100/health",
      }
      const report = await waitHealth(endpoints, { timeoutMs: deps.healthTimeoutMs ?? 120_000 })
      healthReport = report
      const hc = healthChecks(report)
      checks.push(...hc)
      for (const c of hc) emit({ type: "check", result: c })
      if (report.status === "unreachable" || report.status === "unhealthy") {
        throw new PhaseError(
          "health",
          `Health final FALLÓ (${report.status}): ${report.areas.filter((a) => !a.ok).map((a) => a.key).join(", ")}`,
          undefined,
          safeLogPaths(adapter, ctx)[0],
          "health"
        )
      }
      if (report.status === "degraded") {
        warnings.push("Health DEGRADADO: algún componente no responde (realtime/stream) — la app sirve contenido con polling de respaldo")
      }
      return `health: ${report.status}`
    })

    // ============================================================ admin
    await phase("admin", async () => {
      if (!config.adminEmail || !config.adminPassword) {
        emit({ type: "info", message: "Sin credenciales de admin: créalo después con `viewlba-installer admin` o scripts/init-production.ts" })
        return "omitido (se puede crear luego)"
      }
      // REUTILIZA initializeProduction (skipMigrations — ya aplicadas).
      const result = await initProd({
        envFile: layout.envFile,
        databaseUrl: ctx.env.DATABASE_URL,
        adminEmail: config.adminEmail,
        adminPassword: config.adminPassword,
        healthChecks: false,
        skipMigrations: true,
      })
      for (const s of result.steps) emit({ type: "check", result: stepToCheck(s) })
      if (!result.ok) throw new PhaseError("admin", result.error ?? "no se pudo crear el admin", undefined, undefined, "admin")
      adminCreated = result.adminCreated
      if (config.restaurantName && config.restaurantName !== "Mi Restaurante") {
        await applyRestaurantName(config.restaurantName, ctx.env.DATABASE_URL)
      }
      return result.adminCreated ? `admin ${config.adminEmail} creado` : "ya existían admins"
    })

    // ============================================================ finalize
    await phase("finalize", async () => "instalación completa")
  } catch (e) {
    // -------- fallo: diagnóstico + rollback NO destructivo --------
    const pe = e instanceof PhaseError ? e : new PhaseError("preflight", (e as Error).message)
    const logPaths = safeLogPaths(adapter, ctx)
    const diagnostic = buildDiagnostic({
      phase: pe.phase,
      area: pe.area,
      error: pe.message,
      command: pe.command,
      logPath: logPaths[0],
      affectedFile: pe.affectedFile,
    })
    emit({ type: "failed", diagnostic })
    const rollback = await performRollback(registry, {
      rollbackServices: (units) => adapter.rollbackServices(ctx, units),
      emit,
    })
    return {
      ok: false,
      mode: config.mode,
      layout,
      checks,
      warnings,
      urls: buildUrls(config, ctx),
      health: healthReport,
      adminCreated,
      rollback,
      diagnostic,
      durationMs: Date.now() - t0,
    }
  }

  const report: InstallReport = {
    ok: true,
    mode: config.mode,
    layout,
    checks,
    warnings,
    urls: buildUrls(config, ctx),
    health: healthReport,
    adminCreated,
    durationMs: Date.now() - t0,
  }
  emit({ type: "done", report })
  return report
}

// ---------- helpers ----------

function stepToCheck(s: { name: string; status: string; detail?: string }): CheckResult {
  const status = s.status === "ok" ? "pass" : s.status === "skipped" ? "warn" : "fail"
  return { id: `init-${s.name}`, label: s.name, status, detail: s.detail }
}

function buildUrls(config: InstallConfig, ctx: InstallContext): InstallReport["urls"] {
  const fileEnv = readEnvFile(ctx.layout.envFile) ?? {}
  const port = fileEnv.PORT ?? String(config.webPort)
  const ip = config.lanMode ? lanIp() : "127.0.0.1"
  return {
    admin: `http://${ip}:${port}/?view=admin`,
    tv: `http://${ip}:${port}/?view=tv`,
    health: `http://${ip}:${port}/api/health`,
    realtime: `ws://${ip}:${config.realtimePort}`,
    rtmp: `rtmp://${ip}:${config.rtmpPort}/live`,
  }
}

function lanIp(): string {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address
      }
    }
  } catch {
    /* noop */
  }
  return "<IP-del-servidor>"
}

/** Aplica el nombre del restaurante elegido (Settings) con Prisma del server. */
async function applyRestaurantName(name: string, databaseUrl: string): Promise<void> {
  try {
    const { PrismaClient } = (await import("@prisma/client")) as typeof import("@prisma/client")
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      await db.settings.update({ where: { id: "main" }, data: { restaurantName: name } })
    } finally {
      await db.$disconnect().catch(() => {})
    }
  } catch {
    // No fatal: el nombre se puede cambiar desde el panel (Ajustes).
  }
}

function safeLogPaths(adapter: ServiceAdapter, ctx: InstallContext): string[] {
  try {
    return adapter.logPaths(ctx)
  } catch {
    return []
  }
}

function emptyUrls(): InstallReport["urls"] {
  return { admin: "", tv: "", health: "", realtime: "", rtmp: "" }
}
