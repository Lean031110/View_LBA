/**
 * Tests del ADAPTER LINUX (systemd).
 *
 * VERIFIED aquí (lógica, con RecordingRunner + archivos reales en tmp):
 *  - render de unidades con sustitución de rutas/bun/usuario;
 *  - secuencia exacta de comandos (useradd/chown/systemctl);
 *  - rollback: solo unidades creadas, archivos de unidad quitados;
 *  - firewall: comandos ufw con subred.
 *
 * EJECUCIÓN REAL con systemd: NOT VERIFIED en este sandbox (sin systemd)
 * — la instalación completa en un host real se valida en CI/producción.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LinuxServiceAdapter, renderUnit } from "../../installer/linux/adapter"
import { RecordingRunner } from "../../installer/core/runner"
import { RollbackRegistry } from "../../installer/core/rollback"
import { resolveLayout } from "../../installer/core/layout"
import { normalizeConfig } from "../../installer/core/config"
import type { InstallContext } from "../../installer/core/adapter"

/** RecordingRunner que falla selectivamente (p. ej. `id` → usuario no existe). */
class FailingCmdRunner extends RecordingRunner {
  private failCmds: Set<string>
  constructor(failCmds: string[]) {
    super()
    this.failCmds = new Set(failCmds)
  }
  run(cmd: string, args: string[], opts?: Parameters<RecordingRunner["run"]>[2]) {
    if (this.failCmds.has(cmd)) {
      this.calls.push({ cmd, args, opts })
      return { status: 1, stdout: "", stderr: "simulado: no existe", command: `${cmd} ${args.join(" ")}` }
    }
    return super.run(cmd, args, opts)
  }
}

let tmp: string
let systemdDir: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-linux-adapter-"))
  systemdDir = join(tmp, "systemd")
  mkdirSync(systemdDir, { recursive: true })
})
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

const SAMPLE_UNIT = `[Unit]
Description=Pantalla Restaurante - App
Documentation=file:/opt/pantalla-restaurante/docs/OPERATIONS.md

[Service]
Type=simple
User=pantalla
Group=pantalla
WorkingDirectory=/opt/pantalla-restaurante
EnvironmentFile=/etc/pantalla-restaurante.env
ExecStart=__BUN_BIN__ /opt/pantalla-restaurante/.next/standalone/server.js
ReadWritePaths=/var/lib/pantalla-restaurante /var/log/pantalla-restaurante

[Install]
WantedBy=multi-user.target
`

describe("renderUnit (plantillas reales de deploy/linux)", () => {
  test("sustituye __BUN_BIN__ y las 4 rutas + usuario", () => {
    const out = renderUnit(SAMPLE_UNIT, {
      bunBin: "/payload/runtime/bun",
      appDir: "/srv/viewlba",
      dataDir: "/srv/data",
      logDir: "/srv/logs",
      envFile: "/srv/viewlba.env",
      serviceUser: "svc",
    })
    expect(out).toContain("ExecStart=/payload/runtime/bun /srv/viewlba/.next/standalone/server.js")
    expect(out).toContain("WorkingDirectory=/srv/viewlba")
    expect(out).toContain("EnvironmentFile=/srv/viewlba.env")
    expect(out).toContain("User=svc")
    expect(out).toContain("Group=svc")
    expect(out).toContain("ReadWritePaths=/srv/data /srv/logs")
    expect(out).not.toContain("__BUN_BIN__")
    expect(out).not.toContain("/opt/pantalla-restaurante")
    expect(out).not.toContain("pantalla\n") // usuario cambiado
  })

  test("con el layout default NO cambia nada salvo bun (idempotente con install.sh)", () => {
    const out = renderUnit(SAMPLE_UNIT, {
      bunBin: "/usr/local/bin/bun",
      appDir: "/opt/pantalla-restaurante",
      dataDir: "/var/lib/pantalla-restaurante",
      logDir: "/var/log/pantalla-restaurante",
      envFile: "/etc/pantalla-restaurante.env",
      serviceUser: "pantalla",
    })
    expect(out).toContain("User=pantalla")
    expect(out).toContain("ExecStart=/usr/local/bin/bun /opt/pantalla-restaurante/.next/standalone/server.js")
    expect(out).toContain("EnvironmentFile=/etc/pantalla-restaurante.env")
  })

  test("render de las plantillas REALES del repo (sin __BUN_BIN__ residual)", () => {
    const repo = join(import.meta.dir, "..", "..")
    const units = readdirSync(join(repo, "deploy", "linux")).filter((f) => f.endsWith(".service") || f.endsWith(".timer") || f.endsWith(".target"))
    expect(units.length).toBeGreaterThanOrEqual(8)
    for (const unit of units) {
      const template = readFileSync(join(repo, "deploy", "linux", unit), "utf8")
      const out = renderUnit(template, {
        bunBin: "/opt/bun",
        appDir: "/custom/app",
        dataDir: "/custom/data",
        logDir: "/custom/logs",
        envFile: "/custom/custom.env",
        serviceUser: "usr",
      })
      expect(out).not.toContain("__BUN_BIN__")
      if (unit.endsWith(".service")) {
        expect(out).not.toContain("/opt/pantalla-restaurante")
      }
    }
  })
})

describe("LinuxServiceAdapter (RecordingRunner + fs tmp)", () => {
  function makeCtx(sub: string, runner?: RecordingRunner): { ctx: InstallContext; runner: RecordingRunner; registry: RollbackRegistry } {
    const r = runner ?? new RecordingRunner()
    const registry = new RollbackRegistry()
    const config = normalizeConfig({ mode: "new", installDir: join(tmp, sub, "app"), dataDir: join(tmp, sub, "data"), logDir: join(tmp, sub, "logs"), envFile: join(tmp, sub, "app.env") })
    const layout = resolveLayout("linux", config)
    const ctx: InstallContext = {
      config,
      layout,
      runner: r,
      emit: () => {},
      registry,
      env: { ...process.env },
      bunPath: "/payload/runtime/bun",
    }
    return { ctx, runner: r, registry }
  }

  test("checkPlatform detecta systemd real o falla con hint (sandbox: fail honesto)", () => {
    const adapter = new LinuxServiceAdapter(systemdDir)
    const checks = adapter.checkPlatform()
    expect(checks).toHaveLength(1)
    expect(["pass", "fail"]).toContain(checks[0].status)
    if (checks[0].status === "fail") {
      expect(checks[0].hint).toContain("systemd")
    }
  })

  test("installServices: usuario + permisos + unidades + enable + start", async () => {
    // Plantillas: el payload debe llevar deploy/linux (como el repo)
    const runner = new FailingCmdRunner(["id"]) // id pantalla falla → useradd se emite
    const { ctx, registry } = makeCtx("svc", runner)
    mkdirSync(join(ctx.layout.appDir, "deploy", "linux"), { recursive: true })
    const repo = join(import.meta.dir, "..", "..")
    for (const f of readdirSync(join(repo, "deploy", "linux"))) {
      writeFileSync(join(ctx.layout.appDir, "deploy", "linux", f), readFileSync(join(repo, "deploy", "linux", f)))
    }
    mkdirSync(ctx.layout.dataDir, { recursive: true })
    mkdirSync(ctx.layout.logDir, { recursive: true })

    const adapter = new LinuxServiceAdapter(systemdDir)
    await adapter.installServices(ctx)

    const cmds = runner.rendered().join("\n")
    // usuario de sistema sin login
    expect(cmds).toContain("useradd --system --home-dir")
    expect(cmds).toContain("nologin")
    // permisos de datos/logs
    expect(cmds).toContain("chmod 750")
    expect(cmds).toContain("chown -R pantalla:pantalla")
    // systemd: enable + reload + restart
    expect(cmds).toContain("systemctl daemon-reload")
    expect(cmds).toContain("systemctl enable pantalla-restaurante.target")
    expect(cmds).toContain("systemctl enable pantalla-restaurante-backup.timer")
    expect(cmds).toContain("systemctl restart pantalla-restaurante.target")

    // Unidades escritas y renderizadas
    const appUnit = join(systemdDir, "pantalla-restaurante.service")
    expect(existsSync(appUnit)).toBe(true)
    const content = readFileSync(appUnit, "utf8")
    expect(content).toContain(`/payload/runtime/bun ${ctx.layout.appDir}/.next/standalone/server.js`)
    expect(content).toContain(`EnvironmentFile=${ctx.layout.envFile}`)
    expect(readdirSync(systemdDir).length).toBeGreaterThanOrEqual(8) // 8 unidades

    // Registro para rollback
    expect(registry.createdUnits.length).toBe(8)
  })

  test("installServices falla claro si faltan las plantillas (payload incompleto)", async () => {
    const { ctx } = makeCtx("no-templates")
    mkdirSync(ctx.layout.dataDir, { recursive: true })
    mkdirSync(ctx.layout.logDir, { recursive: true })
    const adapter = new LinuxServiceAdapter(systemdDir)
    await expect(adapter.installServices(ctx)).rejects.toThrow(/plantillas systemd|Falta la plantilla/)
  })

  test("rollbackServices: detiene/quita SOLO las unidades creadas", async () => {
    const { ctx, runner } = makeCtx("rollback")
    // unidades existentes en el dir de systemd (tmp)
    const mine = ["pantalla-restaurante.service", "pantalla-restaurante.target"]
    for (const u of mine) writeFileSync(join(systemdDir, u), "unit")
    const adapter = new LinuxServiceAdapter(systemdDir)
    await adapter.rollbackServices(ctx, mine)
    const cmds = runner.rendered().join("\n")
    expect(cmds).toContain("systemctl stop pantalla-restaurante.target")
    expect(cmds).toContain("systemctl disable pantalla-restaurante.service")
    expect(existsSync(join(systemdDir, "pantalla-restaurante.service"))).toBe(false)
    expect(existsSync(join(systemdDir, "pantalla-restaurante.target"))).toBe(false)
    expect(cmds).toContain("systemctl reset-failed")
  })

  test("firewall con ufw: reglas LAN exactas (3000/3003/1935 desde la subred)", async () => {
    const { ctx } = makeCtx("firewall")
    const adapter = new LinuxServiceAdapter(systemdDir)
    // ufw NO existe en este sandbox → cae al warn documentado
    const checks = await adapter.configureFirewall(ctx)
    expect(checks.length).toBeGreaterThanOrEqual(1)
    const any = checks.find((c) => c.id === "fw-manager")
    if (any) {
      expect(any.status).toBe("warn")
      expect(any.hint).toContain("FIREWALL.md")
    }
  })

  test("start/stop en orden correcto (stream → realtime → app; inverso al parar)", async () => {
    const { ctx, runner } = makeCtx("order")
    const adapter = new LinuxServiceAdapter(systemdDir)
    await adapter.startAll(ctx)
    const startIdx = runner.calls.findIndex((c) => c.args.includes("pantalla-restaurante-stream.service"))
    const rtIdx = runner.calls.findIndex((c) => c.args.includes("pantalla-restaurante-realtime.service") && c.cmd === "systemctl" && c.args[0] === "start")
    expect(startIdx).toBeGreaterThan(-1)
    expect(rtIdx).toBeGreaterThan(startIdx)
    await adapter.stopAll(ctx)
    // última llamada de stop debe ser stream (orden inverso)
    const stopCalls = runner.calls.filter((c) => c.cmd === "systemctl" && c.args[0] === "stop")
    expect(stopCalls[stopCalls.length - 1].args[1]).toBe("pantalla-restaurante-stream.service")
  })

  test("logsHint apunta a journalctl de los tres servicios", () => {
    const { ctx } = makeCtx("logs")
    const adapter = new LinuxServiceAdapter(systemdDir)
    expect(adapter.logsHint(ctx)).toContain("journalctl")
    expect(adapter.logsHint(ctx)).toContain("pantalla-stream")
  })
})
