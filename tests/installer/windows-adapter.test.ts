/**
 * Tests del ADAPTER WINDOWS (NSSM) — SOLO LÓGICA con RecordingRunner.
 *
 * EJECUCIÓN REAL EN WINDOWS: **NOT VERIFIED** (sin Windows en este entorno,
 * regla explícita de la misión: "No inventar pruebas Windows reales si no
 * existe Windows"). Lo que SÍ se verifica: la secuencia exacta de comandos
 * NSSM/netsh que el adapter emitiría — misma especificación que
 * deploy/windows/install.ps1 (nombres, parámetros, rotación, firewall).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WindowsServiceAdapter, SERVICE_NAMES, resolveNssm } from "../../installer/windows/adapter"
import { RecordingRunner } from "../../installer/core/runner"
import { RollbackRegistry } from "../../installer/core/rollback"
import { resolveLayout } from "../../installer/core/layout"
import { normalizeConfig } from "../../installer/core/config"
import type { InstallContext } from "../../installer/core/adapter"
import { findInstallation, uninstallAction, DEFAULT_UNINSTALL } from "../../installer/core/manager"

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-win-adapter-"))
})
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

function makeCtx(): { ctx: InstallContext; runner: RecordingRunner; registry: RollbackRegistry } {
  const runner = new RecordingRunner()
  const registry = new RollbackRegistry()
  const config = normalizeConfig({ mode: "new", lanSubnet: "192.168.1.0/24" })
  const layout = resolveLayout("windows", config)
  const ctx: InstallContext = {
    config,
    layout,
    runner,
    emit: () => {},
    registry,
    env: { ...process.env },
    bunPath: "C:\\PantallaRestaurante\\runtime\\bun.exe",
  }
  return { ctx, runner, registry }
}

describe("WindowsServiceAdapter — especificación install.ps1 (lógica)", () => {
  test("3 servicios con los nombres EXACTOS de install.ps1", () => {
    expect(SERVICE_NAMES.app).toBe("PantallaRestaurante")
    expect(SERVICE_NAMES.realtime).toBe("PantallaRestauranteRealtime")
    expect(SERVICE_NAMES.stream).toBe("PantallaRestauranteStream")
  })

  test("checkPlatform: NSSM ausente → FAIL con guía (no silencio)", () => {
    const adapter = new WindowsServiceAdapter("nssm-inexistente")
    const checks = adapter.checkPlatform()
    expect(checks[0].status).toBe("fail")
    expect(checks[0].hint).toContain("nssm")
  })

  test("installServices: secuencia NSSM idéntica a Install-Svc de install.ps1", async () => {
    const { ctx, runner, registry } = makeCtx()
    const adapter = new WindowsServiceAdapter()
    await adapter.installServices(ctx)
    const calls = runner.calls

    // Por cada servicio: stop, remove confirm, install, 9x set
    for (const name of [SERVICE_NAMES.app, SERVICE_NAMES.realtime, SERVICE_NAMES.stream]) {
      const svcCalls = calls.filter((c) => c.cmd === "nssm" && c.args[1] === name)
      const ops = svcCalls.map((c) => c.args[0])
      expect(ops).toContain("stop")
      expect(ops).toContain("remove")
      expect(ops).toContain("install")
      expect(ops).toContain("set")
      // install con bun + entry
      const installCall = svcCalls.find((c) => c.args[0] === "install")!
      expect(installCall.args[2]).toBe(ctx.bunPath)
      // parámetros de install.ps1
      const setArgs = svcCalls.filter((c) => c.args[0] === "set").map((c) => c.args.join(" "))
      expect(setArgs.some((s) => s.includes("AppRestartDelay 5000"))).toBe(true)
      expect(setArgs.some((s) => s.includes("AppRotateFiles 1"))).toBe(true)
      expect(setArgs.some((s) => s.includes("AppRotateBytes 5242880"))).toBe(true)
      expect(setArgs.some((s) => s.includes("AppStdout"))).toBe(true)
      expect(setArgs.some((s) => s.includes("AppStderr"))).toBe(true)
      expect(setArgs.some((s) => s.includes("AppDirectory"))).toBe(true)
    }

    // Entradas exactas de install.ps1:
    const appInstall = calls.find((c) => c.args[0] === "install" && c.args[1] === SERVICE_NAMES.app)!
    expect(appInstall.args[3]).toContain(join("scripts", "start.ts"))
    const rtInstall = calls.find((c) => c.args[0] === "install" && c.args[1] === SERVICE_NAMES.realtime)!
    expect(rtInstall.args[3]).toContain(join("mini-services", "realtime-service", "index.ts"))
    const stInstall = calls.find((c) => c.args[0] === "install" && c.args[1] === SERVICE_NAMES.stream)!
    expect(stInstall.args[3]).toContain(join("mini-services", "stream-service", "index.ts"))

    // Arranque en orden: stream → realtime → app
    const starts = calls.filter((c) => c.args[0] === "start").map((c) => c.args[1])
    expect(starts).toEqual([SERVICE_NAMES.stream, SERVICE_NAMES.realtime, SERVICE_NAMES.app])

    // Registro para rollback
    expect(registry.createdUnits).toContain(SERVICE_NAMES.app)
    expect(registry.createdUnits).toContain(SERVICE_NAMES.realtime)
    expect(registry.createdUnits).toContain(SERVICE_NAMES.stream)
  })

  test("configureFirewall: netsh con reglas y subred exactas (install.ps1/FIREWALL.md)", async () => {
    const { ctx, runner } = makeCtx()
    const adapter = new WindowsServiceAdapter()
    const checks = await adapter.configureFirewall(ctx)
    const netsh = runner.calls.filter((c) => c.cmd === "netsh").map((c) => c.args.join(" "))
    // delete idempotente + add para las 3 reglas
    expect(netsh.some((s) => s.includes("delete rule name=PantallaRestaurante-App"))).toBe(true)
    expect(netsh.some((s) => s.includes("add rule name=PantallaRestaurante-App"))).toBe(true)
    expect(netsh.some((s) => s.includes("localport=3000") && s.includes("remoteip=192.168.1.0/24"))).toBe(true)
    expect(netsh.some((s) => s.includes("localport=3003"))).toBe(true)
    expect(netsh.some((s) => s.includes("localport=1935"))).toBe(true)
    // 3004/8000/8100 NO se abren (localhost por diseño)
    expect(netsh.some((s) => s.includes("localport=3004"))).toBe(false)
    expect(netsh.some((s) => s.includes("localport=8100"))).toBe(false)
    expect(checks.filter((c) => c.status === "pass").length).toBe(3)
  })

  test("rollbackServices: detiene/quita SOLO lo creado + limpia firewall", async () => {
    const { ctx, runner } = makeCtx()
    const adapter = new WindowsServiceAdapter()
    await adapter.rollbackServices(ctx, [SERVICE_NAMES.app, SERVICE_NAMES.stream])
    const ops = runner.calls.filter((c) => c.cmd === "nssm").map((c) => c.args.slice(0, 2).join(" "))
    expect(ops).toContain(`stop ${SERVICE_NAMES.app}`)
    expect(ops).toContain(`remove ${SERVICE_NAMES.app}`)
    expect(ops).toContain(`stop ${SERVICE_NAMES.stream}`)
    expect(ops).not.toContain(`stop ${SERVICE_NAMES.realtime}`) // NO fue creado por el installer
    expect(runner.calls.some((c) => c.cmd === "netsh" && c.args.join(" ").includes("delete rule"))).toBe(true)
  })

  test("stopAll en orden inverso (app → realtime → stream, como manage.ps1)", async () => {
    const { ctx, runner } = makeCtx()
    const adapter = new WindowsServiceAdapter()
    await adapter.stopAll(ctx)
    const stops = runner.calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1])
    expect(stops).toEqual([SERVICE_NAMES.app, SERVICE_NAMES.realtime, SERVICE_NAMES.stream])
  })
})

describe("uninstall windows-safe (lógica compartida del manager)", () => {
  test("por defecto NADA de datos se borra (solo app/servicios/config)", async () => {
    const runner = new RecordingRunner()
    const config = normalizeConfig({ mode: "repair" })
    const layout = resolveLayout("windows", { ...config, installDir: join(tmp, "wapp"), dataDir: join(tmp, "wdata"), envFile: join(tmp, "w.env") })
    const ctx: InstallContext = {
      config,
      layout,
      runner,
      emit: () => {},
      registry: new RollbackRegistry(),
      env: {},
      bunPath: "bun",
    }
    const adapter = new WindowsServiceAdapter()
    const r = await uninstallAction(ctx, adapter, DEFAULT_UNINSTALL, true)
    expect(r.ran).toBe(true)
    expect(r.kept.some((k) => k.includes("CONSERVADO"))).toBe(true)
    expect(r.removed.some((k) => k.includes("ELIMINADO A PETICIÓN"))).toBe(false)
    // servicios removidos
    const ops = runner.calls.filter((c) => c.cmd === "nssm").map((c) => c.args[0])
    expect(ops).toContain("remove")
  })

  test("sin confirmación → sin cambios", async () => {
    const { ctx } = makeCtx()
    const adapter = new WindowsServiceAdapter()
    const r = await uninstallAction(ctx, adapter, DEFAULT_UNINSTALL, false)
    expect(r.ran).toBe(false)
  })
})

describe("resolveNssm", () => {
  test("prefiere el NSSM incluido en el payload; fallback a PATH", () => {
    expect(resolveNssm(tmp)).toBe("nssm") // tmp no tiene runtime/nssm.exe
    expect(resolveNssm()).toBe("nssm")
    expect(resolveNssm(undefined)).toBe("nssm")
  })
})
