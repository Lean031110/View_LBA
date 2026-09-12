/**
 * Tests de INTEGRACIÓN — GATING de temas por licencia (§17 misión 3.1).
 *
 * Servidor REAL en puerto 3302 con entorno AISLADO en estado TRIAL
 * (DB temporal fresca, SIN licencia → trial de 7 días):
 *
 *   · GET /api/admin/themes    → 200 (el trial VISUALIZA el gestor)
 *   · POST importar .vtheme    → 403 license_required (con contacto)
 *   · POST activar tema        → 403
 *   · DELETE tema              → 403
 *   · /api/content sigue sirviendo el tema Default (la TV nunca se rompe)
 *   · el 403 no filtra rutas internas
 *
 * SKIP VISIBLE si el puerto está ocupado (patrón de la suite).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { scryptSync, randomBytes } from "crypto"
import { PrismaClient } from "@prisma/client"
import { writeZip } from "../../src/lib/themes/zip"

const ROOT = resolve(import.meta.dir, "../..")
const APP_PORT = 3302
const APP = `http://127.0.0.1:${APP_PORT}`
const AUTH_SECRET = "thg-secret-0123456789abcdef01234567"
const REALTIME_TOKEN = "thg-rt-internal-token-0123456789ab"
const ADMIN = { email: "admin@thg.test", password: "ThgAdmin12345", name: "Admin Thg" }

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (v: T) => boolean, ms: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    let v: T
    try {
      v = await fn()
    } catch {
      v = undefined as unknown as T
    }
    if (predicate(v)) return v
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout (${ms}ms)`)
    await wait(400)
  }
}

async function portFree(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      return false
    } catch (e) {
      const msg = String((e as Error)?.cause ?? (e as Error).message ?? "")
      if (/refused|ECONN|ENOTFOUND|reset|Unable to connect/i.test(msg)) return true
      await wait(300)
    }
  }
  return false
}

const canRun = await portFree(APP_PORT)
if (!canRun) console.warn(`⚠ themes-gating.test: puerto ${APP_PORT} ocupado — tests omitidos`)

let tmpDir = ""
let app: ChildProcess | null = null
let adminCookie = ""

beforeAll(async () => {
  if (!canRun) return

  tmpDir = mkdtempSync(join(tmpdir(), "viewlba-thg-"))
  const dbPath = join(tmpDir, "thg.db")
  const mig = Bun.spawnSync(["/bin/sh", "-c", `cd '${ROOT}' && DATABASE_URL='file:${dbPath}' exec ./node_modules/.bin/prisma migrate deploy`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (mig.exitCode !== 0) throw new Error("migrate deploy falló: " + mig.stderr.toString().slice(0, 400))

  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })
  const salt = randomBytes(16).toString("hex")
  await db.user.create({
    data: { email: ADMIN.email, name: ADMIN.name, role: "ADMIN", passwordHash: `${salt}:${scryptSync(ADMIN.password, salt, 64).toString("hex")}` },
  })
  await db.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } })
  await db.$disconnect()

  // DATA_DIR/THME_DIR frescos → TRIAL (sin licencia, anclas nuevas)
  const env = [
    `DATABASE_URL='file:${dbPath}'`,
    `AUTH_SECRET='${AUTH_SECRET}'`,
    `REALTIME_TOKEN='${REALTIME_TOKEN}'`,
    `LOGIN_RATE_LIMIT_IP_MAX=500`,
    `DATA_DIR='${tmpDir}'`,
    `THEME_DIR='${join(tmpDir, "themes")}'`,
  ].join(" ")
  app = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${env} exec bunx next dev -p ${APP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  app.stderr?.on("data", (d) => console.log("[thg-app-err]", d.toString().trim().slice(0, 200)))

  await waitFor(async () => (await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)), (r) => !!r && r.ok, 120_000)

  const loginRes = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  })
  adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]
}, 240_000)

afterAll(async () => {
  if (app?.pid) {
    // esperar a que el proceso (y su grupo) muera de verdad: bun reporta
    // los procesos colgantes como fallo «(unnamed)» si quedan vivos
    const died = new Promise<void>((r) => app!.once("exit", () => r()))
    try {
      process.kill(-app.pid, "SIGKILL")
    } catch {
      try {
        app.kill("SIGKILL")
      } catch {}
    }
    await Promise.race([died, new Promise<void>((r) => setTimeout(r, 3000))])
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

/** Paquete .vtheme válido para intentar importar (debe ser rechazado por 403). */
function validPackage(): Buffer {
  return writeZip([
    {
      name: "manifest.json",
      data: Buffer.from(
        JSON.stringify({ schemaVersion: 1, id: "gating-theme", name: "Tema Gating", author: "QA", version: "1.0.0", description: "", minViewLbaVersion: "3.1.0", licenseTier: "full" })
      ),
    },
    { name: "theme.json", data: Buffer.from(JSON.stringify({ clock: { style: "neon" } })) },
  ])
}

describe("GATING de temas — trial (§17)", () => {
  it("GET /api/admin/themes → 200 con los integrados (el trial VISUALIZA)", async () => {
    if (!canRun) return
    const res = await fetch(`${APP}/api/admin/themes`, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { themes: { id: string; builtin: boolean }[] }
    const ids = data.themes.map((t) => t.id)
    expect(ids).toContain("default")
    expect(ids).toContain("viewlba-classic")
    expect(ids).toContain("viewlba-neon")
    // sin importados
    expect(data.themes.every((t) => t.builtin)).toBe(true)
  })

  it("POST /api/admin/themes (importar) → 403 con contacto (license_required)", async () => {
    if (!canRun) return
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(validPackage())], { type: "application/octet-stream" }), "Tema.vtheme")
    const res = await fetch(`${APP}/api/admin/themes`, { method: "POST", headers: { cookie: adminCookie }, body: form })
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: string; feature: string; contact: string }
    expect(data.feature).toBe("themes.custom")
    expect(data.contact).toBe("52973387")
    // mensaje humano, SIN rutas internas
    expect(data.error).not.toContain("/tmp")
    expect(data.error).not.toContain("imported/")
  })

  it("POST /api/admin/themes/default (activar) → 403 (trial no puede aplicar)", async () => {
    if (!canRun) return
    const res = await fetch(`${APP}/api/admin/themes/viewlba-classic`, {
      method: "POST",
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    })
    expect(res.status).toBe(403)
  })

  it("DELETE /api/admin/themes/default → 403 (trial no puede eliminar)", async () => {
    if (!canRun) return
    const res = await fetch(`${APP}/api/admin/themes/default`, { method: "DELETE", headers: { cookie: adminCookie } })
    expect(res.status).toBe(403)
  })

  it("/api/content sigue sirviendo el tema Default (la TV no se rompe en trial)", async () => {
    if (!canRun) return
    const res = await fetch(`${APP}/api/content`)
    expect(res.ok).toBe(true)
    const bundle = (await res.json()) as { theme: { id: string; isDefault: boolean }; license: { watermark: boolean } }
    expect(bundle.theme.id).toBe("default")
    expect(bundle.theme.isDefault).toBe(true)
    expect(bundle.license.watermark).toBe(true) // trial → watermark visible
  })

  it("asset de tema inexistente → 404 (ruta pública degrada sin crash)", async () => {
    if (!canRun) return
    const res = await fetch(`${APP}/api/theme-assets/fantasma/bg.png`)
    expect(res.status).toBe(404)
  })

  it("importar SIN autenticación → 401 (no solo gating)", async () => {
    if (!canRun) return
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(validPackage())], { type: "application/octet-stream" }), "Tema.vtheme")
    const res = await fetch(`${APP}/api/admin/themes`, { method: "POST", body: form })
    expect(res.status).toBe(401)
  })
})
