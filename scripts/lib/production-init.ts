/**
 * Núcleo de inicialización de PRODUCCIÓN (FASE 31, PASO 2).
 *
 * `initializeProduction(options)` es la lógica de negocio REUTILIZABLE:
 * NO lee stdin, NO crea readline, NO llama a process.exit. La interfaz
 * interactiva se construye ENCIMA (scripts/init-production.ts, install.ts)
 * recogiendo credenciales y pasándolas como opciones.
 *
 * Protecciones implementadas (PASO 3-4 del plan):
 *  - El archivo .env se lee DIRECTAMENTE como fuente de verdad (parseEnvFile)
 *    porque dotenv NO sobrescribe variables ya presentes en el entorno: un
 *    shell con DATABASE_URL exportada puede contaminar procesos hijos.
 *  - El target final se aplica EXPLÍCITAMENTE a process.env y a cada proceso
 *    hijo (spawnSync con env explícito).
 *  - VERIFICACIÓN REAL del datasource: se ejecuta `prisma migrate status`
 *    (no muta nada) y se comprueba la línea `Datasource ... at "file:..."`.
 *    Si no coincide con el objetivo → ABORT con mensaje explícito, JAMÁS
 *    se ejecutan migraciones contra una DB inesperada.
 */
import { spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { PrismaClient } from "@prisma/client"
import { reapIfAlive } from "./reap"
import { hashPassword } from "../../src/lib/auth"
import { envError, __resetEnvForTests } from "../../src/lib/env"
import { PASSWORD_POLICY, emailSchema } from "../../src/lib/validators"
import { detectEnvContamination, readEnvFile, resolveDatabaseTarget, sqlitePathsMatch, parseDatasourceUrl } from "./env-file"

/** Raíz del proyecto (scripts/lib/ → 2 niveles arriba). */
export const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..")

export interface InitializeOptions {
  /** Archivo .env a validar/aplicar (fuente de verdad local). */
  envFile?: string
  /** Target DB explícito (gana sobre .env y sobre el entorno contaminado). */
  databaseUrl?: string
  adminEmail?: string
  adminPassword?: string
  /** Sembrar contenido demo (sin usuarios). */
  withDemoData?: boolean
  /** Omitir migraciones (p. ej. ya aplicadas por el caller). */
  skipMigrations?: boolean
  /** Ejecutar health checks (no bloqueantes). */
  healthChecks?: boolean
  appPort?: number
  realtimeHealthUrl?: string
  streamHealthUrl?: string
  /**
   * Directorio de trabajo de los subprocesos (prisma, seed). El instalador
   * compilado DEBE pasarlo (appDir): PROJECT_ROOT se deriva de
   * import.meta.url, que en un binario bun-compile apunta al bunfs VIRTUAL
   * (/$bunfs/root/…, invisible para los hijos) → `bunx prisma` fallaba con
   * cwd inexistente («no se pudo leer el datasource» — bug real v3.2.0).
   * Sin esto (repo/scripts), se usa PROJECT_ROOT como siempre.
   */
  cwd?: string
  /**
   * Ejecutable de Bun para los subprocesos (prisma/seed). El instalador con
   * runtime empaquetado DEBE pasarlo (p. ej. …\runtime\bun.exe): sobre el
   * node_modules PODADO del payload, `bun x prisma` muere con «could not
   * find bin metadata file» (bun no puede remapear los bins — bug real del
   * 9.º build en Windows). El CLI de Prisma se invoca entonces DIRECTO
   * (node_modules/prisma/build/index.js) con ESTE binario. Sin esto se usa
   * «bun» del PATH (repo/scripts, donde bunx también funciona).
   */
  bunPath?: string
}

/**
 * Resuelve el entry JS del bin de `prisma` dentro de un node_modules.
 *
 * INVOCACIÓN DIRECTA (sin `bun x`): el payload del instalador viaja con un
 * node_modules PODADO (PAYLOAD_ROOTS) y `bun x` intenta «remapear» los bins
 * de ese árbol → «could not find bin metadata file / corrupted node_modules»
 * (bug real del 9.º build de v3.2.0 en Windows; en Linux los symlinks de
 * .bin sobreviven y por eso nunca se vio). Llamar al entry del bin con el
 * bun del paquete es portable en ambas plataformas y no depende de .bin.
 *
 * @returns ruta absoluta del CLI o null (no hay node_modules/prisma → el
 *          caller debe recurrir a `bun x prisma`, p. ej. repo con deps).
 */
export function resolvePrismaCli(workRoot: string): string | null {
  const pkgDir = join(workRoot, "node_modules", "prisma")
  const pkgJson = join(pkgDir, "package.json")
  const fallback = join(pkgDir, "build", "index.js")
  try {
    if (existsSync(pkgJson)) {
      const bin = JSON.parse(readFileSync(pkgJson, "utf8")).bin
      const rel = typeof bin === "string" ? bin : bin?.prisma
      if (rel) {
        const cli = join(pkgDir, rel)
        if (existsSync(cli)) return cli
      }
    }
  } catch {
    /* package.json ilegible → fallback estático */
  }
  return existsSync(fallback) ? fallback : null
}

export type StepStatus = "ok" | "skipped" | "failed" | "aborted"

export interface InitStep {
  name: string
  status: StepStatus
  detail?: string
}

export interface InitializeResult {
  ok: boolean
  databaseUrl?: string
  databaseSource?: "explicit" | "env-file" | "process-env"
  steps: InitStep[]
  adminCreated: boolean
  adminEmail?: string
  error?: string
  contaminationWarning?: string
}

export const MISMATCH_ABORT = "Database target mismatch: aborting to prevent modifying another database."

/** Ejecuta un comando con env EXPLÍCITO (sin depender del shell heredado). */
function runWithEnv(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000, cwd?: string): { stdout: string; stderr: string; status: number | null } {
  // stdio[0]="ignore" (lección del 14.º build, Windows): el sidecar corre
  // bajo «cmd /c … > install.log» con el stdin heredado ABIERTO del nsExec
  // de NSIS; un hijo que espere stdin colgaría la instalación completa.
  // Se usan las DOS formas (stdin + stdio[0]): bun admite ambas y node
  // ignora la que no conoce — compatible en cualquier runtime.
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    cwd: cwd ?? PROJECT_ROOT,
    timeout: timeoutMs,
    stdin: "ignore",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  } as never)
  reapIfAlive(r.pid)
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status }
}

/** Env de hijo: heredado + DATABASE_URL explícita (la fuente controlada). */
function childEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: databaseUrl }
}

export async function initializeProduction(options: InitializeOptions): Promise<InitializeResult> {
  // cwd de los subprocesos: la APP instalada (instalador compilado) o el
  // repo (scripts) — NUNCA el bunfs virtual de un binario bun-compile.
  const workRoot = options.cwd ?? PROJECT_ROOT
  // Bin que ejecuta los subprocesos: el del paquete (instalador) o «bun» del
  // PATH (repo). El CLI de prisma se invoca DIRECTO (sin bun x) cuando el
  // node_modules del workRoot lo permite (ver resolvePrismaCli).
  const bunExe = options.bunPath ?? "bun"
  const prismaCli = resolvePrismaCli(workRoot)
  const prismaArgs = prismaCli ? [prismaCli] : ["x", "prisma"]
  const result: InitializeResult = { ok: false, steps: [], adminCreated: false }

  // ---------- 1) Entorno: .env como fuente de verdad + target explícito ----------
  const fileEnv = options.envFile ? readEnvFile(options.envFile) : null
  if (options.envFile && !fileEnv) {
    result.steps = [{ name: "entorno", status: "failed", detail: `no se pudo leer ${options.envFile}` }]
    result.error = `No se pudo leer el archivo de entorno ${options.envFile}`
    return result
  }

  const contamination = detectEnvContamination(fileEnv)
  if (contamination) {
    result.contaminationWarning = contamination
    console.warn(`⚠ ${contamination}`)
  }

  // Aplicar los valores del .env al proceso (descontaminación: el archivo
  // manda para las claves que define) y el target explícito por encima.
  if (fileEnv) {
    for (const [k, v] of Object.entries(fileEnv)) {
      if (!(k in process.env) || process.env[k] !== v) process.env[k] = v
    }
  }

  const target = resolveDatabaseTarget(options.databaseUrl, fileEnv)
  if (!target) {
    result.steps = [{ name: "entorno", status: "failed", detail: "DATABASE_URL no definida (ni opción, ni .env, ni entorno)" }]
    result.error = "DATABASE_URL no definida: proporciona --database-url, un .env válido o expórtala."
    return result
  }
  result.databaseUrl = target.url
  result.databaseSource = target.source
  process.env.DATABASE_URL = target.url // target explícito: JAMÁS el heredado

  // Validación con el MISMO criterio que el servidor (src/lib/env.ts)
  __resetEnvForTests()
  const envErr = envError()
  if (envErr) {
    result.steps = [{ name: "entorno", status: "failed", detail: envErr }]
    result.error = envErr
    return result
  }
  result.steps = [{ name: "entorno", status: "ok", detail: `validado (target DB: ${target.source})` }]

  // ---------- 2) Verificación REAL del datasource (antes de migrar) ----------
  if (!options.skipMigrations) {
    const probe = runWithEnv(bunExe, [...prismaArgs, "migrate", "status"], childEnv(target.url), 180_000, workRoot)
    const datasource = parseDatasourceUrl(probe.stdout + "\n" + probe.stderr)
    if (!datasource) {
      result.steps.push({ name: "database-target", status: "failed", detail: "no se pudo leer el datasource de prisma" })
      result.error = "No se pudo verificar el datasource real de Prisma (¿el CLI de prisma ejecuta con el bun indicado?). Por seguridad no se continúa."
      return result
    }
    if (!sqlitePathsMatch(datasource, target.url, workRoot)) {
      result.steps.push({
        name: "database-target",
        status: "aborted",
        detail: `prisma resolvería ${datasource} pero el objetivo seleccionado es ${target.url}`,
      })
      result.error = `${MISMATCH_ABORT} (prisma apunta a ${datasource}; objetivo: ${target.url})`
      return result
    }
    result.steps.push({ name: "database-target", status: "ok", detail: `verificado: ${datasource}` })
  }

  // ---------- 3) Migraciones (NO destructivas — jamás db push) ----------
  if (options.skipMigrations) {
    result.steps.push({ name: "migrations", status: "skipped", detail: "omitidas por opción" })
  } else {
    const mig = runWithEnv(bunExe, [...prismaArgs, "migrate", "deploy"], childEnv(target.url), 240_000, workRoot)
    if (mig.status !== 0) {
      result.steps.push({ name: "migrations", status: "failed", detail: (mig.stderr || mig.stdout).slice(0, 500) })
      result.error = "prisma migrate deploy falló — no se continúa con admin/seed."
      return result
    }
    result.steps.push({ name: "migrations", status: "ok", detail: "aplicadas / al día" })
  }

  // ---------- 4) Primer administrador ----------
  // PrismaClient DESPUÉS de fijar process.env.DATABASE_URL → apunta al target.
  const db = new PrismaClient()
  try {
    const existingAdmins = await db.user.count({ where: { role: "ADMIN" } })
    if (existingAdmins > 0) {
      result.steps.push({ name: "admin", status: "skipped", detail: `ya existen ${existingAdmins} admins (gestiónalos desde el panel)` })
    } else if (!options.adminEmail || !options.adminPassword) {
      result.steps.push({
        name: "admin",
        status: "skipped",
        detail: "credenciales no proporcionadas — el CLI interactivo debe recogerlas",
      })
    } else {
      const email = emailSchema.safeParse(options.adminEmail)
      if (!email.success) {
        result.steps.push({ name: "admin", status: "failed", detail: "email inválido" })
        result.error = `Email de administrador inválido: ${options.adminEmail}`
        return result
      }
      const pw = PASSWORD_POLICY.safeParse(options.adminPassword)
      if (!pw.success) {
        const why = pw.error.issues.map((i) => i.message).join("; ")
        result.steps.push({ name: "admin", status: "failed", detail: why })
        result.error = `La contraseña del administrador no cumple la política: ${why}`
        return result
      }
      const taken = await db.user.findUnique({ where: { email: email.data } })
      if (taken) {
        result.steps.push({ name: "admin", status: "failed", detail: "email ya registrado" })
        result.error = `Ya existe un usuario con ese email (${email.data})`
        return result
      }
      await db.user.create({
        data: { email: email.data, name: "Administrador", passwordHash: hashPassword(options.adminPassword), role: "ADMIN" },
      })
      result.adminCreated = true
      result.adminEmail = email.data
      result.steps.push({ name: "admin", status: "ok", detail: `creado ${email.data}` })
    }

    // ---------- 5) Ajustes mínimos (settings) ----------
    await db.settings.upsert({
      where: { id: "main" },
      update: {},
      create: {
        id: "main",
        restaurantName: "Mi Restaurante",
        streamEnabled: true,
        streamUrl: "",
        fallbackMessage: "LA TRANSMISIÓN SE REANUDARÁ EN BREVE",
      },
    })
    result.steps.push({ name: "settings", status: "ok", detail: "ajustes base listos" })
  } finally {
    await db.$disconnect().catch(() => {})
  }

  // ---------- 6) Contenido demo opcional (sin usuarios) ----------
  if (options.withDemoData) {
    // Ruta ABSOLUTA del seed (cwd del hijo = workRoot, pero el absoluto es
    // inmune a cualquier discrepancia de resolución relativa).
    const seed = runWithEnv(bunExe, [join(workRoot, "prisma", "seed.ts")], childEnv(target.url), 240_000, workRoot)
    if (seed.status !== 0) {
      result.steps.push({ name: "demo-seed", status: "failed", detail: (seed.stderr || seed.stdout).slice(0, 300) })
      result.ok = false
      result.error = "El seed demo falló (la DB queda inicializada sin contenido demo)."
      return result
    }
    result.steps.push({ name: "demo-seed", status: "ok", detail: "contenido demo sembrado" })
  } else {
    result.steps.push({ name: "demo-seed", status: "skipped", detail: "no solicitado" })
  }

  // ---------- 7) Health checks (no bloqueantes) ----------
  if (options.healthChecks !== false) {
    const port = options.appPort ?? Number(process.env.PORT ?? 3000)
    const checks: Array<[string, string]> = [
      ["health:app", `http://127.0.0.1:${port}/api/health`],
      ["health:realtime", options.realtimeHealthUrl ?? "http://127.0.0.1:3004/health"],
      ["health:stream", options.streamHealthUrl ?? "http://127.0.0.1:8100/health"],
    ]
    for (const [name, url] of checks) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
        result.steps.push({ name, status: "ok", detail: `HTTP ${res.status}` })
      } catch {
        result.steps.push({ name, status: "skipped", detail: "no responde (se iniciará con los servicios)" })
      }
    }
  }

  result.ok = true
  return result
}
