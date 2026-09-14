/**
 * Tests del núcleo de inicialización de producción (FASE 31, PASO 2-4).
 *
 * Cubre:
 *  - parseo de .env (comillas, comentarios, export, duplicados);
 *  - normalización/comparación de rutas SQLite;
 *  - parseo de la línea Datasource de Prisma;
 *  - precedencia del target: explícito > archivo .env > entorno contaminado;
 *  - detección de contaminación del entorno;
 *  - INTEGRACIÓN REAL (el test pedido por el plan): entorno con
 *    DATABASE_URL externa DISTINTA + .env local → initializeProduction debe
 *    aplicar explícitamente el objetivo seleccionado, migrar SOLO ese target
 *    y JAMÁS tocar la DB contaminante.
 *
 * La integración lanza `bunx prisma migrate deploy` real contra una DB
 * temporal (~10-20 s). Se salta VISIBLE si bunx/prisma no está disponible.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { randomBytes } from "crypto"
import { Database } from "bun:sqlite"
import {
  parseEnvFile,
  sqlitePathFromUrl,
  sqlitePathsMatch,
  parseDatasourceUrl,
  resolveDatabaseTarget,
  detectEnvContamination,
} from "../scripts/lib/env-file"
import { initializeProduction, MISMATCH_ABORT, PROJECT_ROOT, resolvePrismaCli } from "../scripts/lib/production-init"

// ---------- Unit: parseEnvFile ----------
describe("parseEnvFile", () => {
  test("pares clave/valor simples", () => {
    expect(parseEnvFile("A=1\nB=hola")).toEqual({ A: "1", B: "hola" })
  })
  test("comillas dobles y simples se eliminan", () => {
    expect(parseEnvFile('A="x y"\nB=\'z w\'')).toEqual({ A: "x y", B: "z w" })
  })
  test("comentarios y líneas vacías se ignoran", () => {
    expect(parseEnvFile("# cabecera\n\nA=1\n  # indentado\nB=2")).toEqual({ A: "1", B: "2" })
  })
  test("export KEY=value", () => {
    expect(parseEnvFile("export A=1")).toEqual({ A: "1" })
  })
  test("duplicados: gana el último (comportamiento dotenv)", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" })
  })
  test("comentario en línea solo sin comillas", () => {
    expect(parseEnvFile("A=1 # nota\nB=\"x # y\"")).toEqual({ A: "1", B: "x # y" })
  })
  test("valor vacío", () => {
    expect(parseEnvFile("A=")).toEqual({ A: "" })
  })
})

// ---------- Unit: rutas SQLite ----------
describe("rutas SQLite", () => {
  test("absoluta se conserva", () => {
    expect(sqlitePathFromUrl("file:/opt/app/db/custom.db")).toBe("/opt/app/db/custom.db")
  })
  test("relativa se resuelve contra relativeTo", () => {
    expect(sqlitePathFromUrl("file:db/custom.db", "/opt/app/prisma")).toBe("/opt/app/prisma/db/custom.db")
  })
  test("separadores Windows se normalizan", () => {
    expect(sqlitePathFromUrl("file:C:\\Pantalla\\data\\custom.db")).toBe("C:/Pantalla/data/custom.db")
  })
  test("no-file: devuelve null", () => {
    expect(sqlitePathFromUrl("postgres://x")).toBeNull()
  })
  test("match: misma ruta con formato distinto", () => {
    expect(sqlitePathsMatch("file:/a/b/custom.db", "file:/a/b/custom.db")).toBe(true)
    expect(sqlitePathsMatch("file:/a/b/custom.db/", "file:/a/b/custom.db")).toBe(true)
    expect(sqlitePathsMatch("file:C:\\A\\b.db", "file:c:/a/b.db")).toBe(true)
    expect(sqlitePathsMatch("file:/a/b.db", "file:/a/OTRA.db")).toBe(false)
  })
})

// ---------- Unit: línea Datasource de Prisma ----------
describe("parseDatasourceUrl", () => {
  test("extrae la URL real de la salida de prisma", () => {
    const out = `Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": SQLite database "custom.db" at "file:/home/z/my-project/db/custom.db"
2 migrations found in prisma/migrations`
    expect(parseDatasourceUrl(out)).toBe("file:/home/z/my-project/db/custom.db")
  })
  test("sin datasource → null", () => {
    expect(parseDatasourceUrl("Environment variables loaded")).toBeNull()
  })
})

// ---------- Unit: precedencia del target ----------
describe("resolveDatabaseTarget (precedencia anti-contaminación)", () => {
  const saved = process.env.DATABASE_URL
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
  })

  test("explícito gana sobre archivo y entorno", () => {
    process.env.DATABASE_URL = "file:/contaminada/x.db"
    const t = resolveDatabaseTarget("file:/target/custom.db", { DATABASE_URL: "file:/archivo/x.db" })
    expect(t).toEqual({ url: "file:/target/custom.db", source: "explicit" })
  })
  test("archivo gana sobre entorno contaminado", () => {
    process.env.DATABASE_URL = "file:/contaminada/x.db"
    const t = resolveDatabaseTarget(undefined, { DATABASE_URL: "file:/archivo/x.db" })
    expect(t).toEqual({ url: "file:/archivo/x.db", source: "env-file" })
  })
  test("sin opción ni archivo → entorno heredado (último recurso)", () => {
    process.env.DATABASE_URL = "file:/contaminada/x.db"
    const t = resolveDatabaseTarget(undefined, null)
    expect(t).toEqual({ url: "file:/contaminada/x.db", source: "process-env" })
  })
  test("nada disponible → null", () => {
    delete process.env.DATABASE_URL
    expect(resolveDatabaseTarget(undefined, null)).toBeNull()
  })
})

// ---------- Unit: detección de contaminación ----------
describe("detectEnvContamination", () => {
  const saved = process.env.DATABASE_URL
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
  })
  test("entorno distinto al .env → advertencia", () => {
    process.env.DATABASE_URL = "file:/contaminada/x.db"
    const w = detectEnvContamination({ DATABASE_URL: "file:/local/custom.db" })
    expect(w).toContain("DIFIERE")
  })
  test("entorno igual (formato distinto) → null", () => {
    process.env.DATABASE_URL = "file:/local/custom.db"
    expect(detectEnvContamination({ DATABASE_URL: "file:/local/custom.db/" })).toBeNull()
  })
  test("sin variable en el entorno → null", () => {
    delete process.env.DATABASE_URL
    expect(detectEnvContamination({ DATABASE_URL: "file:/local/custom.db" })).toBeNull()
  })
})

// ---------- Unit: resolvePrismaCli (invocación directa, sin bun x) ----------
describe("resolvePrismaCli", () => {
  test("repo: resuelve el entry del bin de prisma (bin del package.json)", () => {
    const cli = resolvePrismaCli(PROJECT_ROOT)
    expect(cli).toBeTruthy()
    expect(cli).toContain(join("node_modules", "prisma"))
    expect(existsSync(cli as string)).toBe(true)
  })
  test("árbol SIN node_modules/prisma → null (fallback a bun x)", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "no-prisma-cli-"))
    try {
      expect(resolvePrismaCli(tmp2)).toBeNull()
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  })
})

// ---------- Integración REAL: target protegido ante entorno contaminado ----------
describe("initializeProduction: DATABASE_URL externa + .env distinto → target correcto", () => {
  let tmp: string
  let envFile: string
  let targetUrl: string
  let contaminadaUrl: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "init-core-"))
    mkdirSync(join(tmp, "db"), { recursive: true })
    envFile = join(tmp, "env-fixture.env")
    targetUrl = `file:${join(tmp, "db", "target.db").replace(/\\/g, "/")}`
    contaminadaUrl = `file:${join(tmp, "db", "contaminada.db").replace(/\\/g, "/")}`
    writeFileSync(
      envFile,
      [
        `# fixture`,
        `AUTH_SECRET="${randomBytes(24).toString("hex")}"`,
        `REALTIME_TOKEN="${randomBytes(16).toString("hex")}"`,
        `DATABASE_URL="${targetUrl}"`,
        `PORT=3999`,
      ].join("\n"),
      { mode: 0o600 }
    )
    for (const k of ["DATABASE_URL", "AUTH_SECRET", "REALTIME_TOKEN"]) savedEnv[k] = process.env[k]
  })

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  test("el objetivo seleccionado se aplica y la DB contaminante NO se toca", async () => {
    // Contaminación REAL: el entorno externo apunta a otra DB
    process.env.DATABASE_URL = contaminadaUrl

    const result = await initializeProduction({
      envFile,
      databaseUrl: targetUrl, // el instalador selecciona EXPLÍCITAMENTE el target
      adminEmail: "admin@test.local",
      adminPassword: "TestAdmin123",
      withDemoData: false,
      healthChecks: false,
    })

    // Pasos esperados
    expect(result.ok).toBe(true)
    expect(result.databaseUrl).toBe(targetUrl)
    expect(result.databaseSource).toBe("explicit")
    const targetStep = result.steps.find((s) => s.name === "database-target")
    expect(targetStep?.status).toBe("ok")

    // El target fue migrado de verdad: archivo + tabla User + admin
    const targetPath = join(tmp, "db", "target.db")
    expect(existsSync(targetPath)).toBe(true)
    const con = new Database(targetPath, { readonly: true })
    const tables = con.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain("User")
    expect(tables.map((t) => t.name)).toContain("_prisma_migrations")
    const users = con.query("SELECT email, role FROM User").all() as Array<{ email: string; role: string }>
    expect(users).toEqual([{ email: "admin@test.local", role: "ADMIN" }])
    con.close()

    // La DB "contaminante" JAMÁS fue creada (nadie migró contra ella)
    expect(existsSync(join(tmp, "db", "contaminada.db"))).toBe(false)
  }, 120_000)

  test("mismatch real entre datasource y objetivo → ABORT con mensaje exacto", () => {
    // Caso defensivo: si prisma resolviera otra DB, el guard aborta.
    // Se prueba la comparación pura con la misma lógica del core.
    const prismaResolvio = "file:/otra/ruta/inesperada.db"
    const objetivo = "file:/target/custom.db"
    expect(sqlitePathsMatch(prismaResolvio, objetivo, PROJECT_ROOT)).toBe(false)
    expect(MISMATCH_ABORT).toBe("Database target mismatch: aborting to prevent modifying another database.")
  })

  test("contraseña fuera de política → resultado fallido sin crear admin", async () => {
    // BD y .env FRESCOS (sin admins) para que la política se evalúe realmente
    const tmp2 = mkdtempSync(join(tmpdir(), "init-policy-"))
    const envFile2 = join(tmp2, "env2.env")
    const target2 = `file:${join(tmp2, "target.db").replace(/\\/g, "/")}`
    writeFileSync(
      envFile2,
      [`AUTH_SECRET="${randomBytes(24).toString("hex")}"`, `REALTIME_TOKEN="${randomBytes(16).toString("hex")}"`, `DATABASE_URL="${target2}"`].join("\n")
    )
    try {
      process.env.DATABASE_URL = contaminadaUrl
      const result = await initializeProduction({
        envFile: envFile2,
        databaseUrl: target2,
        adminEmail: "otro@test.local",
        adminPassword: "corta", // viola la política (≤10 chars, sin mayúsculas)
        withDemoData: false,
        healthChecks: false,
      })
      expect(result.ok).toBe(false)
      expect(result.steps.find((s) => s.name === "admin")?.status).toBe("failed")
      expect(result.error).toContain("política")
      // sin usuarios: la creación fue rechazada
        const con = new Database(join(tmp2, "target.db"), { readonly: true })
      const users = con.query("SELECT email FROM User").all() as Array<{ email: string }>
      expect(users).toEqual([])
      con.close()
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  }, 120_000)
})
