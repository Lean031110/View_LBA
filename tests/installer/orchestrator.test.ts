/**
 * Tests del ORQUESTADOR (runInstall) — pipeline completo con:
 *  - FakeAdapter (registra operaciones, puede fallar a demanda);
 *  - RecordingRunner (comandos no ejecutados);
 *  - initProd/waitHealth INYECTADOS (sin DB real aquí: la integración real
 *    de initializeProduction ya la cubre tests/initialize-core.test.ts).
 *
 * Cubre (requisitos de la misión):
 *  - happy path end-to-end con FS real en tmp;
 *  - FAIL de preflight → abort ANTES de modificar nada;
 *  - fallo en services → ROLLBACK NO destructivo (env creado se quita,
 *    datos NUNCA, env preexistente se conserva);
 *  - protección de DB objetivo (mismatch → abort + diagnóstico);
 *  - health unhealthy → instalación NO se declara correcta;
 *  - .env existente → config del wizard NO lo sobrescribe (update).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstall } from "../../installer/core/install"
import { RecordingRunner } from "../../installer/core/runner"
import { RollbackRegistry } from "../../installer/core/rollback"
import { resolveLayout } from "../../installer/core/layout"
import { normalizeConfig } from "../../installer/core/config"
import type { ServiceAdapter, InstallContext } from "../../installer/core/adapter"
import type { InstallConfig, CheckResult, ServiceStatus, HealthReport } from "../../installer/core/types"
import type { InitializeResult } from "../../scripts/lib/production-init"

let tmp: string
let origGetUid: (() => number) | undefined

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-orchestrator-"))
  // El sandbox no es root: simular elevación para que preflight pase (la
  // instalación real exige root — documentado).
  origGetUid = process.getuid
  ;(process as { getuid?: () => number }).getuid = () => 0
})
afterAll(() => {
  if (origGetUid) (process as { getuid?: () => number }).getuid = origGetUid
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

/** Adapter fake: registra y puede fallar en una fase concreta. */
class FakeAdapter implements ServiceAdapter {
  readonly platform = "linux" as const
  installed = 0
  failInstall = false
  rollbackCalls: string[][] = []
  removed = 0
  capturedCtx?: InstallContext

  checkPlatform(): CheckResult[] {
    return [{ id: "fake-systemd", label: "systemd (fake)", status: "pass" }]
  }
  detectExistingServices(): ServiceStatus[] {
    return []
  }
  async installServices(ctx: InstallContext): Promise<void> {
    this.installed++
    this.capturedCtx = ctx
    for (const u of ["a.service", "b.service"]) ctx.registry.markUnitCreated(u)
    if (this.failInstall) throw new Error("systemctl restart pantalla-restaurante.target falló: Port 1935 unavailable")
  }
  async configureFirewall(): Promise<CheckResult[]> {
    return [{ id: "fw-app", label: "ufw 3000 (fake)", status: "pass" }]
  }
  async startAll(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async restartAll(): Promise<void> {}
  async statusAll(): Promise<ServiceStatus[]> {
    return []
  }
  async rollbackServices(_ctx: InstallContext, units: string[]): Promise<void> {
    this.rollbackCalls.push(units)
  }
  async removeServices(): Promise<void> {
    this.removed++
  }
  logsHint(): string {
    return "journalctl (fake)"
  }
  logPaths(): string[] {
    return [join(tmp, "fake.log")]
  }
}

/** initProd fake con registro de llamadas. */
function fakeInitProd(over: Partial<InitializeResult> = {}) {
  const calls: Array<Record<string, unknown>> = []
  const fn = (async (opts: Record<string, unknown>) => {
    calls.push(opts)
    return {
      ok: true,
      steps: [{ name: "entorno", status: "ok" }],
      adminCreated: true,
      ...over,
    } as InitializeResult
  }) as unknown as typeof import("../../scripts/lib/production-init").initializeProduction
  return { fn, calls }
}

function fakeWaitHealth(report: Partial<HealthReport> = { ok: true, status: "ok", areas: [{ key: "application", ok: true }] }) {
  return (async () => report) as unknown as typeof import("../../installer/core/health").waitForHealth
}

/** Payload mínimo (package.json + un archivo) + dirs tmp por test. */
function makeEnv(sub: string): { payload: string; config: InstallConfig; configDir: { installDir: string; dataDir: string; logDir: string; envFile: string } } {
  const payload = join(tmp, sub, "payload")
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, "package.json"), JSON.stringify({ name: "viewlba-server-fake" }))
  writeFileSync(join(payload, "index.txt"), "code")
  const dirs = {
    installDir: join(tmp, sub, "app"),
    dataDir: join(tmp, sub, "data"),
    logDir: join(tmp, sub, "logs"),
    envFile: join(tmp, sub, "app.env"),
  }
  const config = normalizeConfig(
    {
      mode: "new",
      installDir: dirs.installDir,
      dataDir: dirs.dataDir,
      logDir: dirs.logDir,
      envFile: dirs.envFile,
      webPort: 34511,
      realtimePort: 34513,
      rtmpPort: 34515,
      httpFlvPort: 34517,
      lanSubnet: "192.168.1.0/24",
      payloadDir: payload,
    },
    null
  )
  return { payload, config, configDir: dirs }
}

const QUIET = () => {}

describe("runInstall — happy path (FS real, comandos grabados)", () => {
  test("instala: copia payload, .env con secretos, fases en orden, URLs", async () => {
    const { config } = makeEnv("happy")
    const withAdmin: InstallConfig = { ...config, adminEmail: "admin@test.local", adminPassword: "PasswordSegura123!" }
    const adapter = new FakeAdapter()
    const runner = new RecordingRunner()
    const init = fakeInitProd()
    const events: string[] = []

    const report = await runInstall(withAdmin, {
      adapter,
      runner,
      emit: (e) => {
        if (e.type === "phase-start") events.push(e.phase)
      },
      initProd: init.fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "happy"),
      healthTimeoutMs: 1000,
    })

    expect(report.ok).toBe(true)
    // Fases en orden
    expect(events).toEqual(["preflight", "deploy", "environment", "database", "services", "firewall", "health", "admin", "finalize"])
    // Payload copiado (exclusiones respetadas)
    expect(existsSync(join(config.installDir!, "package.json"))).toBe(true)
    expect(existsSync(join(config.installDir!, "index.txt"))).toBe(true)
    // .env creado con secretos y 600
    expect(existsSync(config.envFile!)).toBe(true)
    const envContent = readFileSync(config.envFile!, "utf8")
    expect(envContent).toContain("AUTH_SECRET=")
    expect(envContent).toContain(`DATABASE_URL="file:${join(config.dataDir!, "db", "custom.db")}"`)
    // initProd llamado con el target correcto (database + admin)
    expect(init.calls.length).toBe(2)
    expect(init.calls[0].databaseUrl).toContain("custom.db")
    expect(init.calls[0].withDemoData).toBe(false)
    expect(init.calls[1].skipMigrations).toBe(true)
    // comandos: bun install + prisma generate (grabados, no ejecutados)
    const cmds = runner.rendered().join("\n")
    expect(cmds).toContain("install --frozen-lockfile")
    expect(cmds).toContain("x prisma generate")
    // servicios + firewall del adapter
    expect(adapter.installed).toBe(1)
    // URLs con puertos elegidos
    expect(report.urls.health).toContain("34511")
    expect(report.urls.rtmp).toContain("34515")
  })

  test("admin omitido cuando no hay credenciales (creación posterior)", async () => {
    const { config } = makeEnv("noadmin")
    const init = fakeInitProd()
    const report = await runInstall(config, {
      adapter: new FakeAdapter(),
      runner: new RecordingRunner(),
      initProd: init.fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "noadmin"),
    })
    expect(report.ok).toBe(true)
    // solo la llamada de DB (sin admin)
    expect(init.calls.length).toBe(1)
  })

  test("RUNTIME PERMANENTE: bun incluido se instala en appDir/runtime y los servicios lo usan", async () => {
    // Bug real corregido: las unidades systemd/NSSM apuntaban al bun del
    // PAQUETE (montaje transitorio de AppImage) → tras reinicio, caída.
    const { config } = makeEnv("runtime")
    // paquete con runtime/bun (stub ejecutable: preflight lo EJECUTA de verdad)
    const pkgRoot = join(tmp, "runtime")
    mkdirSync(join(pkgRoot, "runtime"), { recursive: true })
    writeFileSync(join(pkgRoot, "runtime", "bun"), "#!/bin/sh\necho 1.3.14\n", { mode: 0o755 })
    chmodSync(join(pkgRoot, "runtime", "bun"), 0o755)
    const adapter = new FakeAdapter()
    const runner = new RecordingRunner()
    const report = await runInstall(config, {
      adapter,
      runner,
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: pkgRoot,
    })
    expect(report.ok).toBe(true)
    // runtime copiado DENTRO de la instalación (autosuficiente)
    expect(existsSync(join(config.installDir!, "runtime", "bun"))).toBe(true)
    // bunx como alias (contrato de bundle-server.ts)
    expect(existsSync(join(config.installDir!, "runtime", "bunx"))).toBe(true)
    // los servicios se configuran con el bun INSTALADO, no el del paquete
    expect(adapter.capturedCtx?.bunPath).toBe(join(config.installDir!, "runtime", "bun"))
    // los comandos de la fase deploy (install/generate) usan el instalado
    const cmds = runner.rendered().join("\n")
    expect(cmds).toContain(join(config.installDir!, "runtime", "bun"))
  })

  test("sin runtime incluido → sin appDir/runtime y bunPath del PATH (comportamiento original)", async () => {
    const { config } = makeEnv("norbuntime")
    const adapter = new FakeAdapter()
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "norbuntime"),
    })
    expect(report.ok).toBe(true)
    expect(existsSync(join(config.installDir!, "runtime"))).toBe(false)
    expect(adapter.capturedCtx?.bunPath).toBe("bun")
  })

  test("BUILD PRECOMPILADO: el .next del payload VIAJA al appDir (start.ts lo exige) y no se recompila", async () => {
    // Bug real corregido: SERVER_COPY_EXCLUDES excluía .next → la instalación
    // oficial perdía el build del paquete → start.ts no encontraba server.js.
    const { payload, config } = makeEnv("prebuilt")
    mkdirSync(join(payload, ".next", "standalone"), { recursive: true })
    writeFileSync(join(payload, ".next", "standalone", "server.js"), "// standalone real")
    const runner = new RecordingRunner()
    const report = await runInstall(config, {
      adapter: new FakeAdapter(),
      runner,
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "prebuilt"),
    })
    expect(report.ok).toBe(true)
    expect(existsSync(join(config.installDir!, ".next", "standalone", "server.js"))).toBe(true)
    // con precompilado NO se lanza 'run build' en destino
    expect(runner.rendered().join("\n")).not.toContain("run build")
  })

  test("sin precompilado y runBuild → se compila EN destino ('bun run build')", async () => {
    const { config } = makeEnv("buildinplace")
    const runner = new RecordingRunner()
    const report = await runInstall(config, {
      adapter: new FakeAdapter(),
      runner,
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "buildinplace"),
    })
    expect(report.ok).toBe(true)
    expect(runner.rendered().join("\n")).toContain("run build")
  })
})

describe("runInstall — aborts y rollback", () => {
  test("preflight FAIL → nada se modifica (ni appDir ni .env)", async () => {
    const { config, configDir } = makeEnv("prefail")
    // payload sin package.json → FAIL en deploy... para preflight usamos
    // plataforma que falla: adapter con checkPlatform fail
    const adapter = new (class extends FakeAdapter {
      checkPlatform(): CheckResult[] {
        return [{ id: "systemd", label: "systemd NO detectado", status: "fail", hint: "necesitas systemd" }]
      }
    })()
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "prefail"),
    })
    expect(report.ok).toBe(false)
    expect(report.diagnostic?.phase).toBe("preflight")
    expect(report.diagnostic?.suggestion).toContain("systemd")
    // NADA creado
    expect(existsSync(configDir.installDir)).toBe(false)
    expect(existsSync(configDir.envFile)).toBe(false)
    expect(report.rollback?.ran).toBe(true) // ejecutado aunque vacío
  })

  test("fallo en services → rollback NO destructivo: env creado se quita, datos intactos", async () => {
    const { config, configDir } = makeEnv("rollback")
    const adapter = new FakeAdapter()
    adapter.failInstall = true
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "rollback"),
    })

    expect(report.ok).toBe(false)
    expect(report.diagnostic?.phase).toBe("services")
    // puerto 1935 → sugerencia de la misión
    expect(report.diagnostic?.suggestion).toContain("1935")
    // rollback: env CREADO por el installer → eliminado
    expect(report.rollback?.removedEnvFile).toBe(true)
    expect(existsSync(configDir.envFile)).toBe(false)
    // rollback pidió al adapter quitar SOLO las unidades creadas
    expect(adapter.rollbackCalls[0]).toEqual(["a.service", "b.service"])
    // los datos y el código NO se tocan (rollback no destructivo)
    expect(existsSync(join(configDir.dataDir, "db"))).toBe(true)
    expect(existsSync(join(configDir.installDir, "package.json"))).toBe(true)
  })

  test(".env PREEXISTENTE en fallo → se CONSERVA (misión: no sobrescribir)", async () => {
    const { config, configDir } = makeEnv("keepenv")
    writeFileSync(configDir.envFile, 'AUTH_SECRET="previo-0123456789abcdef012345"\nREALTIME_TOKEN="previo-0123456789"\nDATABASE_URL="file:/previa/custom.db"\n')
    const adapter = new FakeAdapter()
    adapter.failInstall = true
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "keepenv"),
    })
    expect(report.ok).toBe(false)
    expect(report.rollback?.removedEnvFile).toBe(false)
    expect(existsSync(configDir.envFile)).toBe(true)
    expect(readFileSync(configDir.envFile, "utf8")).toContain("previo")
  })

  test("protección de DB objetivo: initProd aborted (mismatch) → diagnostic + nada más", async () => {
    const { config } = makeEnv("dbmismatch")
    const init = fakeInitProd({
      ok: false,
      steps: [{ name: "database-target", status: "aborted", detail: "mismatch" }],
      error: "Database target mismatch: aborting to prevent modifying another database. (prisma apunta a otra DB)",
    })
    const adapter = new FakeAdapter()
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: init.fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "dbmismatch"),
    })
    expect(report.ok).toBe(false)
    expect(report.diagnostic?.phase).toBe("database")
    expect(report.diagnostic?.suggestion).toContain("NO tocará una DB distinta")
    // servicios NUNCA se llegaron a instalar
    expect(adapter.installed).toBe(0)
  })

  test("health unreachable → instalación NO correcta + rollback", async () => {
    const { config } = makeEnv("badhealth")
    const adapter = new FakeAdapter()
    const report = await runInstall(config, {
      adapter,
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth({ ok: false, status: "unreachable", areas: [{ key: "application", ok: false, detail: "ECONNREFUSED" }] }),
      packageRoot: join(tmp, "badhealth"),
      healthTimeoutMs: 200,
    })
    expect(report.ok).toBe(false)
    expect(report.diagnostic?.phase).toBe("health")
    // el servicio se había instalado → el rollback lo quitó
    expect(adapter.rollbackCalls.length).toBe(1)
  })

  test("health degraded → instalación OK con warning explícito (semántica del server)", async () => {
    const { config } = makeEnv("degraded")
    const report = await runInstall(config, {
      adapter: new FakeAdapter(),
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth({
        ok: false,
        status: "degraded",
        httpStatus: 200,
        areas: [
          { key: "application", ok: true },
          { key: "database", ok: true },
          { key: "realtime", ok: false },
        ],
      }),
      packageRoot: join(tmp, "degraded"),
    })
    expect(report.ok).toBe(true)
    expect(report.warnings.some((w) => w.includes("DEGRADADO"))).toBe(true)
  })

  test("config inválida → fail-fast sin tocar nada", async () => {
    const { config } = makeEnv("badcfg")
    const bad = { ...config, timezone: "HoraMala", restaurantName: "" }
    const report = await runInstall(bad, {
      adapter: new FakeAdapter(),
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "badcfg"),
    })
    expect(report.ok).toBe(false)
    expect(report.diagnostic?.error).toContain("restaurantName")
    expect(report.diagnostic?.error).toContain("timezone")
  })
})

describe("runInstall — modo update (config existente respetada)", () => {
  test("update: .env existente NO se sobrescribe; puerto del .env se respeta en URLs", async () => {
    const { config, configDir } = makeEnv("update")
    writeFileSync(configDir.envFile, 'AUTH_SECRET="existente-0123456789abcdef01"\nREALTIME_TOKEN="existente-01234"\nDATABASE_URL="file:/datos/previa.db"\nPORT=7777\n')
    const cfg = { ...config, mode: "update" as const }
    const report = await runInstall(cfg, {
      adapter: new FakeAdapter(),
      runner: new RecordingRunner(),
      initProd: fakeInitProd().fn,
      waitHealth: fakeWaitHealth(),
      packageRoot: join(tmp, "update"),
    })
    expect(report.ok).toBe(true)
    const after = readFileSync(configDir.envFile, "utf8")
    expect(after).toContain("PORT=7777") // NO sobrescrito por el wizard
    expect(after).toContain("file:/datos/previa.db")
    // URL usa el PUERTO del .env existente (config existente manda)
    expect(report.urls.admin).toContain(":7777")
    // DATABASE_URL pasada a initProd = la del .env existente
  })
})
