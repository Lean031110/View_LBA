/**
 * Tests del CORE del installer oficial (misión: unit tests del core).
 *
 * Cubre: config (defaults/validación/env entries), layout por plataforma,
 * secrets (generación, merge conservador, permisos, nunca imprimir),
 * detección de instalación previa, diagnóstico estructurado, health
 * (parseo del JSON real de /api/health), puertos (TCP real) y fsx.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeConfig, validateConfig, configToEnvEntries } from "../../installer/core/config"
import { resolveLayout, layoutDirs, LINUX_DEFAULTS, WINDOWS_DEFAULTS } from "../../installer/core/layout"
import { renderEnvContent, ensureEnvFile, envSecretsComplete, generateSecret } from "../../installer/core/secrets"
import { detectExisting, describeExisting } from "../../installer/core/existing"
import { buildDiagnostic, renderDiagnostic } from "../../installer/core/diagnostics"
import { healthChecks, waitForHealth } from "../../installer/core/health"
import { checkPorts, portAvailable, requiredPorts } from "../../installer/core/ports"
import { copyDirFiltered, SERVER_COPY_EXCLUDES } from "../../installer/core/fsx"
import { systemChecks, suggestSubnet, defaultGateway } from "../../installer/core/sysinfo"
import type { InstallConfig } from "../../installer/core/types"

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-installer-core-"))
})
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

// ---------- config ----------
describe("config: defaults y validación", () => {
  test("defaults de la misión (America/Havana, 3000/3003/1935/8000, LAN)", () => {
    const c = normalizeConfig({ mode: "new" }, "192.168.1.50")
    expect(c.timezone).toBe("America/Havana")
    expect(c.webPort).toBe(3000)
    expect(c.realtimePort).toBe(3003)
    expect(c.rtmpPort).toBe(1935)
    expect(c.httpFlvPort).toBe(8000)
    expect(c.lanMode).toBe(true)
    expect(c.lanSubnet).toBe("192.168.1.0/24")
  })

  test("config inválida produce issues accionables", () => {
    const bad: InstallConfig = {
      mode: "new",
      restaurantName: "",
      timezone: "HoraMala",
      webPort: 70000,
      realtimePort: 3000, // duplicado
      rtmpPort: -1,
      httpFlvPort: 3000, // duplicado con realtimePort
      lanMode: true,
      withDemoData: false,
      offline: false,
      runBuild: true,
      lanSubnet: "no-es-subred",
      adminEmail: "no-email",
    }
    const issues = validateConfig(bad)
    const fields = issues.map((i) => i.field)
    expect(fields).toContain("restaurantName")
    expect(fields).toContain("timezone")
    expect(fields).toContain("webPort")
    expect(fields).toContain("rtmpPort")
    expect(fields).toContain("ports")
    expect(fields).toContain("lanSubnet")
    expect(fields).toContain("adminEmail")
  })

  test("offline implica no compilar (payload precompilado)", () => {
    const c = normalizeConfig({ offline: true, runBuild: true })
    expect(c.runBuild).toBe(false)
  })

  test("configToEnvEntries: claves que el server entiende + puertos no default explícitos", () => {
    const layout = resolveLayout("linux", {})
    const entries = configToEnvEntries(
      { ...normalizeConfig({ realtimePort: 4003, rtmpPort: 2935 }) },
      layout
    )
    const map = Object.fromEntries(entries)
    expect(map.PORT).toBe("3000")
    expect(map.NODE_ENV).toBe("production")
    expect(map.TIMEZONE).toBe("America/Havana")
    expect(map.DATABASE_URL).toBe(layout.dbUrl)
    expect(map.REALTIME_PORT).toBe("4003")
    expect(map.RTMP_PORT).toBe("2935")
    expect(map.HTTP_FLV_PORT).toBeUndefined() // default → no se escribe
  })
})

// ---------- layout ----------
describe("layout por plataforma", () => {
  test("linux default = convención FHS de install.sh", () => {
    const l = resolveLayout("linux", {})
    expect(l.appDir).toBe(LINUX_DEFAULTS.appDir)
    expect(l.dataDir).toBe("/var/lib/pantalla-restaurante")
    expect(l.logDir).toBe("/var/log/pantalla-restaurante")
    expect(l.envFile).toBe("/etc/pantalla-restaurante.env")
    expect(l.serviceUser).toBe("pantalla")
    expect(l.dbUrl).toBe("file:/var/lib/pantalla-restaurante/db/custom.db")
  })

  test("linux con dirs personalizados", () => {
    const l = resolveLayout("linux", { installDir: "/srv/viewlba", dataDir: "/srv/data", logDir: "/srv/logs", envFile: "/srv/viewlba.env" })
    expect(l.appDir).toBe("/srv/viewlba")
    expect(l.dbUrl).toBe("file:/srv/data/db/custom.db")
    expect(l.envFile).toBe("/srv/viewlba.env")
    expect(l.mediaDir).toBe("/srv/data/media")
  })

  test("windows default = convención de install.ps1", () => {
    const l = resolveLayout("windows", {})
    expect(l.appDir).toBe(WINDOWS_DEFAULTS.appDir)
    expect(l.dataDir).toBe("C:\\PantallaRestaurante\\data")
    expect(l.envFile).toBe("C:\\PantallaRestaurante\\app\\.env")
    expect(l.dbUrl).toBe("file:C:/PantallaRestaurante/data/db/custom.db")
    expect(l.serviceUser).toBeNull()
  })

  test("layoutDirs cubre el árbol de datos completo", () => {
    const l = resolveLayout("linux", { dataDir: "/d", logDir: "/l" })
    const dirs = layoutDirs(l)
    for (const want of ["/d", "/d/db", "/d/media", "/d/backups", "/l"]) {
      expect(dirs).toContain(want)
    }
  })
})

// ---------- secrets ----------
describe("secrets: .env seguro y conservador", () => {
  test("generación crypto (hex, longitud)", () => {
    const s = generateSecret(24)
    expect(s).toMatch(/^[0-9a-f]{48}$/)
  })

  test("contenido renderizado: secretos entre comillas, sin placeholders", () => {
    const cfg = normalizeConfig({ mode: "new" })
    const layout = resolveLayout("linux", { dataDir: "/d" })
    const content = renderEnvContent(cfg, layout, { authSecret: "a".repeat(48), realtimeToken: "b".repeat(32) })
    expect(content).toContain('AUTH_SECRET="')
    expect(content).toContain('REALTIME_TOKEN="')
    expect(content).toContain(`DATABASE_URL="file:/d/db/custom.db"`)
    expect(content).not.toContain("change-me")
    expect(content).not.toContain("changeme")
    // No debe incluir los valores en texto plano sin comillas (se verifican aparte)
    expect(content.split('AUTH_SECRET="')[1]?.startsWith("a".repeat(10))).toBe(true)
  })

  test("instalación nueva: .env creado con 600 y secretos completos", () => {
    const envFile = join(tmp, "new", ".env")
    mkdirSync(join(tmp, "new"), { recursive: true })
    const cfg = normalizeConfig({ mode: "new" })
    const layout = resolveLayout("linux", { dataDir: join(tmp, "new-data"), envFile })
    const res = ensureEnvFile(cfg, layout)
    expect(res.created).toBe(true)
    expect(envSecretsComplete(envFile)).toBe(true)
    // Permisos 600 (POSIX)
    expect(statSync(envFile).mode & 0o077).toBe(0)
    const content = readFileSync(envFile, "utf8")
    expect(content).not.toContain("GENERADO_CON_VALOR_IMPRESO")
  })

  test(".env EXISTENTE: se respeta TODO, solo se añaden faltantes (misión: no sobrescribir)", () => {
    const envFile = join(tmp, "exist", ".env")
    mkdirSync(join(tmp, "exist"), { recursive: true })
    writeFileSync(
      envFile,
      [
        "# existente",
        'AUTH_SECRET="secreto-original-del-usuario-1234567890"',
        "PORT=3311",
        "TIMEZONE=Europe/Madrid",
        "",
      ].join("\n")
    )
    const cfg = normalizeConfig({ mode: "update", webPort: 3000 })
    const layout = resolveLayout("linux", { dataDir: join(tmp, "exist-data"), envFile })
    const res = ensureEnvFile(cfg, layout)
    expect(res.existed).toBe(true)
    expect(res.created).toBe(false)
    expect(res.added.sort()).toEqual(["DATABASE_URL", "REALTIME_TOKEN"]) // solo lo que falta
    const after = readFileSync(envFile, "utf8")
    expect(after).toContain("secreto-original-del-usuario-1234567890") // NO se regeneró
    expect(after).toContain("PORT=3311") // NO se sobrescribió
    expect(envSecretsComplete(envFile)).toBe(true)
  })

  test(".env ya completo: cero cambios", () => {
    const envFile = join(tmp, "full", ".env")
    mkdirSync(join(tmp, "full"), { recursive: true })
    writeFileSync(envFile, `AUTH_SECRET="${"a".repeat(48)}"\nREALTIME_TOKEN="${"b".repeat(32)}"\nDATABASE_URL="file:/x/custom.db"\n`)
    const layout = resolveLayout("linux", { dataDir: "/x", envFile })
    const res = ensureEnvFile(normalizeConfig({}), layout)
    expect(res.added).toEqual([])
    expect(res.keptKeys.sort()).toEqual(["AUTH_SECRET", "DATABASE_URL", "REALTIME_TOKEN"])
  })
})

// ---------- existing ----------
describe("detección de instalación previa", () => {
  test("equipo limpio → new", () => {
    const layout = resolveLayout("linux", { installDir: join(tmp, "none-a"), dataDir: join(tmp, "none-d"), envFile: join(tmp, "none.env") })
    const e = detectExisting(layout, { detectServices: () => [] })
    expect(e.suggestedMode).toBe("new")
    expect(e.hasApp).toBe(false)
    expect(e.hasDatabase).toBe(false)
  })

  test("app + servicios activos → update", () => {
    const app = join(tmp, "upd-app")
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, "package.json"), "{}")
    const layout = resolveLayout("linux", { installDir: app, dataDir: join(tmp, "upd-d"), envFile: join(tmp, "upd.env") })
    const e = detectExisting(layout, {
      detectServices: () => [{ key: "app", name: "pantalla-restaurante.service", active: true }],
    })
    expect(e.suggestedMode).toBe("update")
  })

  test("env/DB sin servicios → repair (instalación a medias)", () => {
    const data = join(tmp, "rep-d")
    const layout = resolveLayout("linux", { installDir: join(tmp, "rep-a"), dataDir: data, envFile: join(tmp, "rep.env") })
    mkdirSync(`${data}/db`, { recursive: true })
    writeFileSync(layout.dbFile, "contenido-real") // > 0 bytes
    writeFileSync(layout.envFile, 'AUTH_SECRET="x"')
    const e = detectExisting(layout, { detectServices: () => [] })
    expect(e.suggestedMode).toBe("repair")
    expect(e.hasDatabase).toBe(true)
  })

  test("db de 0 bytes NO cuenta como datos (a medias)", () => {
    const data = join(tmp, "zero-d")
    const layout = resolveLayout("linux", { installDir: join(tmp, "zero-a"), dataDir: data, envFile: join(tmp, "zero.env") })
    mkdirSync(`${data}/db`, { recursive: true })
    writeFileSync(layout.dbFile, "")
    const e = detectExisting(layout, { detectServices: () => [] })
    expect(e.hasDatabase).toBe(false)
  })

  test("describeExisting no revela secretos", () => {
    const layout = resolveLayout("linux", { installDir: join(tmp, "desc-a"), dataDir: join(tmp, "desc-d"), envFile: join(tmp, "desc.env") })
    writeFileSync(layout.envFile, 'AUTH_SECRET="SECRETO_MUY_SECRETO_123"')
    const e = detectExisting(layout, { detectServices: () => [] })
    const lines = describeExisting(e).join("\n")
    expect(lines).not.toContain("SECRETO_MUY_SECRETO_123")
  })
})

// ---------- diagnostics ----------
describe("diagnóstico estructurado (formato de la misión)", () => {
  test("puerto RTMP ocupado → sugerencia exacta", () => {
    const d = buildDiagnostic({ phase: "services", error: "Port 1935 unavailable" })
    expect(d.suggestion).toContain("1935")
    expect(d.suggestion).toContain("puerto RTMP")
    const text = renderDiagnostic(d)
    expect(text).toContain("STATUS: FAIL")
    expect(text).toContain("Motivo:")
    expect(text).toContain("Acción:")
  })

  test("mismatch de DB → protección explícita", () => {
    const d = buildDiagnostic({ phase: "database", error: "Database target mismatch: aborting to prevent modifying another database." })
    expect(d.suggestion).toContain("NO tocará una DB distinta")
  })

  test("health timeout → fase y acción", () => {
    const d = buildDiagnostic({ phase: "health", error: "ECONNREFUSED health timeout" })
    expect(d.phase).toBe("health")
    expect(d.suggestion).toContain("Reparar")
  })
})

// ---------- health ----------
describe("health: parseo real de /api/health", () => {
  test("ok → 5 áreas pass", () => {
    const checks = healthChecks({
      ok: true,
      status: "ok",
      httpStatus: 200,
      areas: [
        { key: "application", ok: true },
        { key: "database", ok: true },
        { key: "storage", ok: true },
        { key: "realtime", ok: true },
        { key: "stream", ok: true },
      ],
    })
    expect(checks).toHaveLength(5)
    expect(checks.every((c) => c.status === "pass")).toBe(true)
  })

  test("unhealthy (DB) → fail bloqueante", () => {
    const checks = healthChecks({
      ok: false,
      status: "unhealthy",
      areas: [{ key: "database", ok: false }],
    })
    const db = checks.find((c) => c.id === "health-database")!
    expect(db.status).toBe("fail")
  })

  test("degraded → warn, no fail", () => {
    const checks = healthChecks({
      ok: false,
      status: "degraded",
      httpStatus: 200,
      areas: [
        { key: "application", ok: true },
        { key: "database", ok: true },
        { key: "storage", ok: true },
        { key: "realtime", ok: false },
        { key: "stream", ok: false },
      ],
    })
    const rt = checks.find((c) => c.id === "health-realtime")!
    expect(rt.status).toBe("warn")
  })

  test("waitForHealth con fetch falso: unreachable tras timeout", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const report = await waitForHealth({ app: "http://127.0.0.1:1/api/health", realtime: "", stream: "" }, { timeoutMs: 300, intervalMs: 100, fetchFn: fakeFetch })
    expect(report.status).toBe("unreachable")
    expect(report.ok).toBe(false)
  })

  test("waitForHealth con respuesta JSON real (semántica del servidor)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          status: "degraded",
          database: { ok: true },
          storage: { ok: true },
          realtime: { ok: false },
          stream: { ok: true },
          ts: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch
    const report = await waitForHealth({ app: "http://x/api/health", realtime: "", stream: "" }, { timeoutMs: 1000, fetchFn: fakeFetch })
    expect(report.status).toBe("degraded")
    expect(report.areas.find((a) => a.key === "realtime")?.ok).toBe(false)
    expect(report.areas.find((a) => a.key === "database")?.ok).toBe(true)
  })
})

// ---------- puertos ----------
describe("puertos TCP (sin comandos externos)", () => {
  test("puerto libre → disponible; puerto ocupado → no disponible", async () => {
    const free = await portAvailable("127.0.0.1", 0 as unknown as number === 0 ? 23457 : 23457)
    expect(free).toBe(true)
    const { createServer } = await import("node:net")
    const blocker = createServer()
    await new Promise<void>((res) => blocker.listen(23458, "127.0.0.1", () => res()))
    const busy = await portAvailable("127.0.0.1", 23458)
    expect(busy).toBe(false)
    await new Promise<void>((res) => blocker.close(() => res()))
  })

  test("checkPorts: ocupado por OTRO → fail; ocupado por PROPIOS servicios → warn", async () => {
    const { createServer } = await import("node:net")
    const blocker = createServer()
    await new Promise<void>((res) => blocker.listen(23459, "0.0.0.0", () => res()))
    const specs = requiredPorts(23459, 13003, 11935, 18000)
    const other = await checkPorts(specs, new Set())
    expect(other.find((c) => c.id === "web")?.status).toBe("fail")
    const own = await checkPorts(specs, new Set([23459]))
    expect(own.find((c) => c.id === "web")?.status).toBe("warn")
    expect(own.find((c) => c.id === "rtmp")?.status).toBe("pass")
    await new Promise<void>((res) => blocker.close(() => res()))
  })
})

// ---------- fsx ----------
describe("fsx: copia con exclusiones (sin POSIX)", () => {
  test("copyDirFiltered respeta exclusiones estándar y copia contenido", () => {
    const src = join(tmp, "payload")
    mkdirSync(join(src, "src"), { recursive: true })
    mkdirSync(join(src, ".git"), { recursive: true })
    mkdirSync(join(src, "node_modules"), { recursive: true })
    writeFileSync(join(src, "package.json"), '{"name":"server"}')
    writeFileSync(join(src, "src", "index.ts"), "export {}")
    writeFileSync(join(src, ".git", "HEAD"), "ref")
    writeFileSync(join(src, "node_modules", "x.js"), "x")
    writeFileSync(join(src, ".env"), "AUTH_SECRET=no")
    const dest = join(tmp, "dest")
    const count = copyDirFiltered(src, dest)
    expect(existsSync(join(dest, "package.json"))).toBe(true)
    expect(existsSync(join(dest, "src", "index.ts"))).toBe(true)
    expect(existsSync(join(dest, ".git"))).toBe(false)
    expect(existsSync(join(dest, "node_modules"))).toBe(false)
    expect(existsSync(join(dest, ".env"))).toBe(false)
    expect(count).toBe(2)
    expect(SERVER_COPY_EXCLUDES).toContain("node_modules")
  })
})

// ---------- sysinfo ----------
describe("sysinfo", () => {
  test("subnet sugerida de la IP", () => {
    expect(suggestSubnet("192.168.1.50")).toBe("192.168.1.0/24")
    expect(suggestSubnet(null)).toBeNull()
    expect(suggestSubnet("10.0.0.5")).toBe("10.0.0.0/24")
  })

  test("systemChecks: sin disco medible → warn, no fail; disco insuficiente → fail", () => {
    const info = {
      platform: "linux" as const,
      os: "linux x64",
      arch: "x64",
      cpuModel: "test",
      cpuCores: 2,
      ramTotalBytes: 4 * 1024 ** 3,
      ramFreeBytes: 1 * 1024 ** 3,
      diskFreeBytes: null,
      hostname: "h",
      ipLan: "192.168.1.10",
      gateway: "192.168.1.1",
      elevated: true,
      filesystem: null,
    }
    const checks = systemChecks(info, "/tmp", null)
    expect(checks.find((c) => c.id === "disk")?.status).toBe("warn")
    const low = systemChecks(info, "/tmp", 1 * 1024 ** 3)
    expect(low.find((c) => c.id === "disk")?.status).toBe("fail")
    const ok = systemChecks(info, "/tmp", 10 * 1024 ** 3)
    expect(ok.find((c) => c.id === "disk")?.status).toBe("pass")
  })

  test("gateway: parseo de /proc/net/route o null (nunca throw)", () => {
    const gw = defaultGateway()
    expect(gw === null || /^\d+\.\d+\.\d+\.\d+$/.test(gw)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolvePackageRoot: detección del bunfs VIRTUAL por plataforma (regresión
// del 7.º build de v3.2.0: en Windows el prefijo es B:\~BUN\root\…, NO
// «$bunfs» — el sidecar buscaba su payload en B:\~BUN\root).
// ---------------------------------------------------------------------------
describe("resolvePackageRoot — binario compilado (bunfs virtual)", () => {
  test("argv[1] con prefijo Windows B:\\~BUN → usa process.execPath (exe real)", async () => {
    const realArgv = [...process.argv]
    const realExec = process.execPath
    try {
      // construir un fake-package junto a un «exe» real (bun mismo)
      process.argv = [realArgv[0]!, "B:\\~BUN\\root\\viewlba-installer.exe"]
      const { resolvePackageRoot } = await import("../../installer/core/install")
      // en el sandbox interpretado: execPath = bun real → su dir NO es
      // packageRoot válido → cae al fallback (exeDir) SIN tocar B:\
      const root = resolvePackageRoot()
      expect(root.startsWith("B:")).toBe(false)
      expect(root).toBeTruthy()
    } finally {
      process.argv = realArgv
      process.execPath = realExec
    }
  })

  test("argv[1] con prefijo Linux /$bunfs → usa process.execPath (exe real)", async () => {
    const realArgv = [...process.argv]
    try {
      process.argv = [realArgv[0]!, "/$bunfs/root/viewlba-installer"]
      const { resolvePackageRoot } = await import("../../installer/core/install")
      const root = resolvePackageRoot()
      expect(root.includes("$bunfs")).toBe(false)
      expect(root).toBeTruthy()
    } finally {
      process.argv = realArgv
    }
  })
})
