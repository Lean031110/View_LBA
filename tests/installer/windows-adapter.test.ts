/**
 * Tests del ADAPTER WINDOWS — Fase 2 (post-NSSM).
 *
 * El adapter YA NO USA NSSM. En su lugar delega al service host Rust
 * (viewlba-service.exe) que se registra con SCM via CreateServiceW.
 *
 * Lo que se verifica aquí:
 *   - El adapter existe y exporta WindowsServiceAdapter
 *   - SERVICE_NAMES usa "ViewLBA" (no "PantallaRestaurante*")
 *   - resolveServiceHost busca en rutas Program Files (no en runtime/nssm.exe)
 *   - El adapter NO invoca nssm.exe en ningún path
 *
 * La verificación REAL de que viewlba-service.exe registra y arranca el
 * servicio en SCM se hace en CI con el workflow test-windows-artifact.yml
 * sobre el artefacto REAL descargado (misión §10).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WindowsServiceAdapter, SERVICE_NAMES, resolveServiceHost } from "../../installer/windows/adapter"
import { RecordingRunner } from "../../installer/core/runner"
import { resolveLayout } from "../../installer/core/layout"
import { normalizeConfig } from "../../installer/core/config"

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-win-adapter-v2-"))
})
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

describe("WindowsServiceAdapter (Fase 2 — post-NSSM)", () => {
  test("exporta WindowsServiceAdapter + SERVICE_NAMES + resolveServiceHost", () => {
    expect(WindowsServiceAdapter).toBeDefined()
    expect(SERVICE_NAMES).toBeDefined()
    expect(resolveServiceHost).toBeDefined()
  })

  test("SERVICE_NAMES usa 'ViewLBA' (no PantallaRestaurante* — misión §33)", () => {
    expect(SERVICE_NAMES.app).toBe("ViewLBA")
    expect(SERVICE_NAMES.realtime).toBe("ViewLBA")
    expect(SERVICE_NAMES.stream).toBe("ViewLBA")
    // No debe haber referencias a PantallaRestaurante
    expect(JSON.stringify(SERVICE_NAMES)).not.toMatch(/PantallaRestaurante/i)
  })

  test("resolveServiceHost busca viewlba-service.exe en Program Files (no runtime/nssm.exe)", () => {
    // Layout real (Program Files\ViewLBA Server\bin\viewlba-service.exe)
    const installRoot = join(tmp, "installed")
    mkdirSync(join(installRoot, "bin"), { recursive: true })
    writeFileSync(join(installRoot, "bin", "viewlba-service.exe"), "fake binary")
    expect(resolveServiceHost(installRoot)).toBe(join(installRoot, "bin", "viewlba-service.exe"))
  })

  test("resolveServiceHost fallback a 'viewlba-service' del PATH si no encuentra el binario", () => {
    const nonExistent = join(tmp, "no-existe")
    expect(resolveServiceHost(nonExistent)).toBe("viewlba-service")
  })

  test("el adapter NO invoca nssm.exe en ninguna operación", () => {
    // El source del adapter no debe contener invocaciones a nssm.exe
    const adapterSource = require("node:fs").readFileSync(
      join(process.cwd(), "installer/windows/adapter.ts"),
      "utf8"
    )
    // Patrón de INVOCACIÓN (no menciones en comentarios):
    // runner.run(this.nssmPath, ...) o runner.run("nssm", ...)
    expect(adapterSource).not.toMatch(/runner\.run\(\s*this\.nssmPath/)
    expect(adapterSource).not.toMatch(/runner\.run\(\s*["'`]nssm["'`]/)
    // Ya no debe tener el campo nssmPath
    expect(adapterSource).not.toMatch(/private\s+nssmPath/)
  })

  test("el adapter invoca viewlba-service.exe para todas las operaciones de servicio", () => {
    const adapterSource = require("node:fs").readFileSync(
      join(process.cwd(), "installer/windows/adapter.ts"),
      "utf8"
    )
    // Las operaciones deben delegar al service host
    expect(adapterSource).toMatch(/runner\.run\(\s*this\.serviceHostPath.*--install/)
    expect(adapterSource).toMatch(/runner\.run\(\s*this\.serviceHostPath.*--start/)
    expect(adapterSource).toMatch(/runner\.run\(\s*this\.serviceHostPath.*--stop/)
    expect(adapterSource).toMatch(/runner\.run\(\s*this\.serviceHostPath.*--uninstall/)
  })

  test("logsHint apunta a service-host.log (no PantallaRestaurante.log)", () => {
    const adapter = new WindowsServiceAdapter()
    const layout = resolveLayout("C:\\Program Files\\ViewLBA Server", "C:\\ProgramData\\ViewLBA", normalizeConfig({ mode: "new" } as any, "192.168.1.50"))
    const ctx = {
      layout,
      runner: new RecordingRunner(),
      config: normalizeConfig({ mode: "new" } as any, "192.168.1.50"),
      emit: () => {},
      registry: { markServiceStarted: () => {}, markUnitCreated: () => {} },
      bunPath: "bun",
    } as any
    const hint = adapter.logsHint(ctx)
    expect(hint).toContain("service-host.log")
    expect(hint).not.toMatch(/PantallaRestaurante\.log/)
  })

  test("logPaths devuelve los 4 logs estructurados (host + app + realtime + stream)", () => {
    const adapter = new WindowsServiceAdapter()
    const layout = resolveLayout("C:\\Program Files\\ViewLBA Server", "C:\\ProgramData\\ViewLBA", normalizeConfig({ mode: "new" } as any, "192.168.1.50"))
    const ctx = {
      layout,
      runner: new RecordingRunner(),
      config: normalizeConfig({ mode: "new" } as any, "192.168.1.50"),
      emit: () => {},
      registry: { markServiceStarted: () => {}, markUnitCreated: () => {} },
      bunPath: "bun",
    } as any
    const paths = adapter.logPaths(ctx)
    expect(paths).toHaveLength(4)
    expect(paths.some((p: string) => p.includes("service-host.log"))).toBe(true)
    expect(paths.some((p: string) => p.includes("app.log"))).toBe(true)
    expect(paths.some((p: string) => p.includes("realtime.log"))).toBe(true)
    expect(paths.some((p: string) => p.includes("stream.log"))).toBe(true)
  })

  test("checkPlatform verifica viewlba-service.exe (no NSSM)", () => {
    const adapter = new WindowsServiceAdapter("viewlba-service") // sin path real → fallback
    const checks = adapter.checkPlatform()
    // Debe haber un check con id 'viewlba-service'
    expect(checks.some(c => c.id === "viewlba-service")).toBe(true)
    // No debe haber checks con id 'nssm'
    expect(checks.some(c => c.id === "nssm")).toBe(false)
  })
})
