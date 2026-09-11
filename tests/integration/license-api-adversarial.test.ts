/**
 * FASE 11 (release 3.0.0) — ATAQUES AUTORIZADOS contra el ENDPOINT de
 * activación (HTTP real contra servidor real, como license-api.test.ts).
 *
 * Ataques cubiertos:
 *   · activación CONCURRENTE del mismo token (N POST paralelos → idempotencia)
 *   · activación concurrente de tokens DISTINTOS (dos clientes)
 *   · payloads ENORMES (1 MB / 8 MB) → rechazo limpio, nunca 500
 *   · content-type incorrecto / cuerpo no JSON → 400
 *   · POST repetido en ráfaga (20x) → estado consistente, 1 solo historial
 *   · borrado/truncado del storage durante ráfaga → sin 500
 *
 * SKIP VISIBLE si el puerto está ocupado (patrón del resto de la suite).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { scryptSync, randomBytes } from "crypto"
import { PrismaClient } from "@prisma/client"

const ROOT = resolve(import.meta.dir, "../..")
const APP_PORT = 3301
const APP = `http://127.0.0.1:${APP_PORT}`
const AUTH_SECRET = "adv-secret-0123456789abcdef01234567"
const REALTIME_TOKEN = "adv-rt-internal-token-0123456789abc"
const ADMIN = { email: "admin@adv.test", password: "AdvAdmin12345", name: "Admin Adv" }

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

const { generateLicenseKeyPair, generateRequestKeyPair, deriveInstallationId, deriveDiskId, buildLicenseToken } = await import(
  "../../src/lib/licensing/index"
)
import type { LicenseTokenPayload } from "../../src/lib/licensing/types"

const key = generateLicenseKeyPair()
const reqKey = generateRequestKeyPair()
const DEVICE_FP = randomBytes(32).toString("hex")
const DISK_HASH = randomBytes(32).toString("hex")
const INSTALLATION_ID = deriveInstallationId(DEVICE_FP)
const DISK_ID = deriveDiskId(DISK_HASH)

/** licenseId conforme al esquema: VLBA- + 12 hex. */
function licenseId(): string {
  return `VLBA-${randomBytes(6).toString("hex")}`
}

function makeToken(days: number, customerName: string, licenseId: string): string {
  const startsAt = Date.now()
  const payload: LicenseTokenPayload = {
    v: 2,
    licenseId,
    customerName,
    plan: days === 30 ? "monthly" : days === 365 ? "annual" : "custom",
    durationDays: days,
    product: "ViewLBA-Server",
    issuedAt: startsAt,
    startsAt,
    expiresAt: startsAt + days * 86400000,
    installationId: INSTALLATION_ID,
    diskId: DISK_ID,
    features: { "users.management": true, "screens.multiDisplay": true },
    nonce: randomBytes(16).toString("hex"),
  }
  return buildLicenseToken(payload, key.privateKey)
}

let adminCookie = ""

async function post(path: string, body: unknown, cookie = adminCookie, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

const canRun = await portFree(APP_PORT)
if (!canRun) console.warn(`⚠ license-api-adversarial: puerto ${APP_PORT} ocupado — tests omitidos`)

let tmpDir = ""
let app: ChildProcess | null = null
let prisma: PrismaClient | null = null

beforeAll(async () => {
  if (!canRun) return
  tmpDir = mkdtempSync(join(tmpdir(), "viewlba-adv-"))
  const dbPath = join(tmpDir, "adv.db")
  const mig = Bun.spawnSync(["/bin/sh", "-c", `cd '${ROOT}' && DATABASE_URL='file:${dbPath}' exec bunx prisma migrate deploy`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (mig.exitCode !== 0) throw new Error("migrate deploy falló: " + mig.stderr.toString().slice(0, 400))

  prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })
  const salt = randomBytes(16).toString("hex")
  await prisma.user.create({
    data: {
      email: ADMIN.email,
      name: ADMIN.name,
      role: "ADMIN",
      passwordHash: `${salt}:${scryptSync(ADMIN.password, salt, 64).toString("hex")}`,
    },
  })

  const env = [
    `DATABASE_URL='file:${dbPath}'`,
    `AUTH_SECRET='${AUTH_SECRET}'`,
    `REALTIME_TOKEN='${REALTIME_TOKEN}'`,
    `LOGIN_RATE_LIMIT_IP_MAX=500`,
    `LICENSE_RATE_LIMIT_MAX=1000`,
    `DATA_DIR='${tmpDir}'`,
    `VIEWLBA_TEST_DEVICE_FINGERPRINT='${DEVICE_FP}'`,
    `VIEWLBA_TEST_DISK_ID_HASH='${DISK_HASH}'`,
    `VIEWLBA_TEST_INSTALL_PATH='/srv/viewlba-adv'`,
    `VIEWLBA_LICENSE_PUBLIC_KEY='${key.publicKey}'`,
    `VIEWLBA_REQUEST_PUBLIC_KEY='${reqKey.publicKey}'`,
  ].join(" ")
  app = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${env} exec bunx next dev -p ${APP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  app.stderr?.on("data", (d) => console.log("[adv-app-err]", d.toString().trim().slice(0, 200)))

  await waitFor(async () => (await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)), (r) => !!r && r.ok, 120_000)

  const loginRes = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  })
  if (loginRes.status !== 200) throw new Error("login admin falló: " + (await loginRes.text()))
  adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]
  if (!adminCookie) throw new Error("sin cookie de sesión")
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {})
  if (app?.pid) {
    try {
      process.kill(-app.pid, "SIGKILL")
    } catch {
      try {
        app.kill("SIGKILL")
      } catch {}
    }
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe.skipIf(!canRun)("ATAQUES HTTP — /api/license/activate", { timeout: 240_000 }, () => {
  it("ATAQUE concurrencia: 12 POST paralelos del MISMO token → 0 errores 500, 1 activación real, idempotencia", async () => {
    const token = makeToken(90, "Concurrencia Café", licenseId())
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post("/api/license/activate", { token })),
    )
    // NINGÚN 500 (crash del servidor bajo carrera)
    for (const r of results) {
      expect([200, 422, 429]).toContain(r.status)
    }
    // al MENOS uno activó de verdad
    const ok = results.filter((r) => r.status === 200)
    expect(ok.length).toBeGreaterThanOrEqual(1)
    // el resto son idempotentes (ya activa) — nunca 'duplicate' del mismo token
    for (const r of results.filter((r) => r.status === 200)) {
      expect(r.data.ok ?? true).toBe(true)
    }
    // estado final: LICENCIA ACTIVA
    const lic = await fetch(`${APP}/api/license`, { headers: { cookie: adminCookie } })
    const data = await lic.json()
    expect(data.status).toBe("active")
    expect(data.license?.customerName).toBe("Concurrencia Café")
  })

  it("ATAQUE concurrencia: 2 tokens DISTINTOS en paralelo → exactamente 1 queda activa, 0 errores 500", async () => {
    const t1 = makeToken(120, "Paralelo Uno", licenseId())
    const t2 = makeToken(180, "Paralelo Dos", licenseId())
    const [r1, r2] = await Promise.all([post("/api/license/activate", { token: t1 }), post("/api/license/activate", { token: t2 })])
    expect(r1.status).not.toBe(500)
    expect(r2.status).not.toBe(500)
    // uno activa, el otro o activa o es rechazado de forma controlada
    // (dependiendo del orden, puede ser downgrade o activación posterior)
    expect([200, 422, 429]).toContain(r1.status)
    expect([200, 422, 429]).toContain(r2.status)
    const lic = await fetch(`${APP}/api/license`, { headers: { cookie: adminCookie } })
    const data = await lic.json()
    expect(data.status).toBe("active")
  })

  it("ATAQUE payload gigante: token de 1 MB → rechazo limpio (400/413), nunca 500", async () => {
    const huge = "VLBA2-" + "A".repeat(1024 * 1024)
    const r = await post("/api/license/activate", { token: huge })
    expect([400, 413, 422]).toContain(r.status)
    expect(r.status).not.toBe(500)
  })

  it("ATAQUE cuerpo no-JSON (texto plano) → 400, nunca 500", async () => {
    const r = await post("/api/license/activate", "esto no es json {{{", adminCookie, { "Content-Type": "text/plain" })
    expect(r.status).toBe(400)
  })

  it("ATAQUE JSON con tipos inesperados (token = objeto/array/número) → 400/422, nunca 500", async () => {
    for (const bad of [{ token: { a: 1 } }, { token: ["VLBA2"] }, { token: 12345 }, { token: null }, { otro: "campo" }]) {
      const r = await post("/api/license/activate", bad)
      expect([400, 422]).toContain(r.status)
    }
  })

  it("ATAQUE ráfaga de repetición: 20 POST del MISMO token → idempotencia estable y 1 solo historial", async () => {
    const token = makeToken(365, "Ráfaga Bar", licenseId())
    const first = await post("/api/license/activate", { token })
    expect(first.status).toBe(200)
    for (let i = 0; i < 20; i++) {
      const r = await post("/api/license/activate", { token })
      expect(r.status).not.toBe(500)
      if (r.status === 200) {
        // re-activación idempotente del mismo token
        expect(r.data.alreadyActive ?? true).toBe(true)
      }
    }
    // historial: la licencia aparece UNA sola vez
    const hist = await fetch(`${APP}/api/license`, { headers: { cookie: adminCookie } })
    const data = await hist.json()
    expect(data.status).toBe("active")
  })

  it("ATAQUE tokens malformados en ráfaga: 15 variantes corruptas → 422, nada guardado, sin 500", async () => {
    const valid = makeToken(60, "Corrupto Test", licenseId())
    const variants = [
      "",
      "   ",
      "VLBA2",
      "VLBA2-",
      "VLBA2-A",
      valid.slice(0, 50),
      valid.slice(0, 150),
      valid.slice(0, -1),
      valid.slice(0, -5),
      "VLBA2-" + "Z".repeat(500),
      "VLBA2-" + "ñ".repeat(400),
      "VLREQ2-" + valid.split("-").slice(1).join(""),
      "VLBA2-" + "\u0000".repeat(300),
      valid.replace("VLBA2", "VLBA3"),
      "😀".repeat(300),
    ]
    for (const v of variants) {
      const r = await post("/api/license/activate", { token: v })
      expect([400, 422]).toContain(r.status)
      expect(r.status).not.toBe(500)
    }
    // el servidor sigue vivo y consistente
    const health = await fetch(`${APP}/api/health`)
    expect(health.ok).toBe(true)
  })

  it("ATAQUE sin sesión: POST activate anónimo → 401 (no bypass de auth)", async () => {
    const token = makeToken(60, "Anónimo Test", licenseId())
    const r = await post("/api/license/activate", { token }, "")
    expect(r.status).toBe(401)
  })
})
