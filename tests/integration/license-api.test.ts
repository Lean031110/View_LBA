/**
 * Tests de INTEGRACIÓN del sistema de licencias v2 (token copiar/pegar) —
 * contra un servidor REAL.
 *
 * Se levanta `next dev` en el puerto 3300 con entorno AISLADO:
 *  · DB temporal (migraciones reales + usuario admin de prueba)
 *  · DATA_DIR temporal (anclas de trial frescas → trial de 7 días)
 *  · Overrides de identidad de test (VIEWLBA_TEST_*) + claves públicas de test
 *
 * Cubre el flujo completo de la UX (requisito v2):
 *  1. Trial: watermark público en /api/content + gating server-side (403)
 *  2. GET /api/license público SIN secretos y SIN Installation/Disk ID
 *  3. POST /api/license/request-code → código VLREQ2 (se abre con la clave
 *     X25519 de test del "emisor" → customerName + binding correctos)
 *  4. POST /api/license/activate: token válido → ACTIVA; manipulado →
 *     rechazado; de otro equipo → rechazo humano; renovación; downgrade
 *  5. Post-activación: watermark fuera, premium habilitado, historial en DB
 *
 * SKIP VISIBLE si el puerto está ocupado (patrón de recovery.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { scryptSync, randomBytes } from "crypto"
import { PrismaClient } from "@prisma/client"

const ROOT = resolve(import.meta.dir, "../..")
const APP_PORT = 3300
const APP = `http://127.0.0.1:${APP_PORT}`
const AUTH_SECRET = "lic-secret-0123456789abcdef0123456789"
const REALTIME_TOKEN = "lic-rt-internal-token-0123456789abcdef"

const ADMIN = { email: "admin@lic.test", password: "LicAdmin12345", name: "Admin Lic" }

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

// ---------------- claves e identidad de test (efímeras) ----------------
const { generateLicenseKeyPair, generateRequestKeyPair, deriveInstallationId, deriveDiskId, openRequestCode, buildLicenseToken } = await import(
  "../../src/lib/licensing/index"
)
import type { LicenseTokenPayload } from "../../src/lib/licensing/types"

const key = generateLicenseKeyPair() // Ed25519 del "emisor" (Android de test)
const reqKey = generateRequestKeyPair() // X25519 de apertura de solicitudes
const DEVICE_FP = randomBytes(32).toString("hex")
const DISK_HASH = randomBytes(32).toString("hex")
const INSTALLATION_ID = deriveInstallationId(DEVICE_FP)
const DISK_ID = deriveDiskId(DISK_HASH)
const INSTALL_PATH = "/srv/viewlba-lic-test"

function makeTokenPayload(opts: { days?: number; customerName?: string; installationId?: string; diskId?: string; licenseId?: string } = {}): LicenseTokenPayload {
  const days = opts.days ?? 365
  const startsAt = Date.now()
  return {
    v: 2,
    licenseId: opts.licenseId ?? `VLBA-${randomBytes(6).toString("hex")}`,
    customerName: opts.customerName ?? "Restaurante La Terraza",
    plan: days === 30 ? "monthly" : days === 365 ? "annual" : "custom",
    durationDays: days,
    product: "ViewLBA-Server",
    issuedAt: startsAt,
    startsAt,
    expiresAt: startsAt + days * 86400000,
    installationId: opts.installationId ?? INSTALLATION_ID,
    diskId: opts.diskId ?? DISK_ID,
    features: { "users.management": true, "screens.multiDisplay": true, "themes.custom": true },
    nonce: randomBytes(16).toString("hex"),
  }
}

function makeToken(opts: Parameters<typeof makeTokenPayload>[0] = {}): string {
  return buildLicenseToken(makeTokenPayload(opts), key.privateKey)
}

// ---------------- helpers HTTP ----------------
let adminCookie = ""

async function api(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

async function activate(token: string, cookie = adminCookie): Promise<{ status: number; data: any }> {
  return api("POST", "/api/license/activate", { token }, cookie)
}

// ---------------- entorno del servidor ----------------
const canRun = await portFree(APP_PORT)
if (!canRun) {
  console.warn(`⚠ license-api.test: puerto ${APP_PORT} ocupado — tests omitidos`)
}

let tmpDir = ""
let app: ChildProcess | null = null

// timeout amplio (arranca next dev, que compila bajo demanda — como recovery.test.ts)
beforeAll(async () => {
  if (!canRun) return

  // DB temporal con migraciones + admin
  tmpDir = mkdtempSync(join(tmpdir(), "viewlba-lic-"))
  const dbPath = join(tmpDir, "lic.db")
  const mig = Bun.spawnSync(["/bin/sh", "-c", `cd '${ROOT}' && DATABASE_URL='file:${dbPath}' exec bunx prisma migrate deploy`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (mig.exitCode !== 0) throw new Error("migrate deploy falló: " + mig.stderr.toString().slice(0, 400))

  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })
  const salt = randomBytes(16).toString("hex")
  await db.user.create({
    data: {
      email: ADMIN.email,
      name: ADMIN.name,
      role: "ADMIN",
      passwordHash: `${salt}:${scryptSync(ADMIN.password, salt, 64).toString("hex")}`,
    },
  })
  await db.$disconnect()

  // servidor dev aislado con identidad de test + DATA_DIR fresco (trial)
  const env = [
    `DATABASE_URL='file:${dbPath}'`,
    `AUTH_SECRET='${AUTH_SECRET}'`,
    `REALTIME_TOKEN='${REALTIME_TOKEN}'`,
    `LOGIN_RATE_LIMIT_IP_MAX=500`,
    `DATA_DIR='${tmpDir}'`,
    `VIEWLBA_TEST_DEVICE_FINGERPRINT='${DEVICE_FP}'`,
    `VIEWLBA_TEST_DISK_ID_HASH='${DISK_HASH}'`,
    `VIEWLBA_TEST_INSTALL_PATH='${INSTALL_PATH}'`,
    `VIEWLBA_LICENSE_PUBLIC_KEY='${key.publicKey}'`,
    `VIEWLBA_REQUEST_PUBLIC_KEY='${reqKey.publicKey}'`,
  ].join(" ")
  app = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${env} exec bunx next dev -p ${APP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  app.stderr?.on("data", (d) => console.log("[lic-app-err]", d.toString().trim().slice(0, 200)))

  // espera health (compila bajo demanda)
  await waitFor(async () => (await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)), (r) => !!r && r.ok, 120_000)

  // login admin (cookie de sesión por header, como e2e/helpers.ts)
  const loginRes = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  })
  if (loginRes.status !== 200) throw new Error("login admin falló: " + (await loginRes.text()))
  const setCookie = loginRes.headers.get("set-cookie") ?? ""
  adminCookie = setCookie.split(";")[0]
  if (!adminCookie) throw new Error("sin cookie de sesión")
}, 240_000)

afterAll(() => {
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

describe.skipIf(!canRun)("LICENSING integración — fase TRIAL (sin licencia)", { timeout: 240_000 }, () => {
  it("la primera petición a /api/content arranca el trial y expone watermark público (sin secretos)", async () => {
    const res = await fetch(`${APP}/api/content`, { cache: "no-store" })
    expect(res.status).toBe(200)
    const bundle = (await res.json()) as { license: { status: string; watermark: boolean; watermarkLines: string[] | null } }
    expect(bundle.license.status).toBe("trial")
    expect(bundle.license.watermark).toBe(true)
    expect(bundle.license.watermarkLines?.[0]).toContain("VERSIÓN DE PRUEBA")
    expect(JSON.stringify(bundle)).not.toContain("customerName")
    expect(JSON.stringify(bundle)).not.toContain(ADMIN.email)
  })

  it("GET /api/license (público): estado trial, watermark y features — sin datos de cliente ni IDs de binding", async () => {
    const { status, data } = await api("GET", "/api/license")
    expect(status).toBe(200)
    expect(data.status).toBe("trial")
    expect(data.watermark.visible).toBe(true)
    expect(data.features["users.management"]).toBe(false)
    const json = JSON.stringify(data)
    expect(json).not.toContain("customerName")
    expect(json).not.toContain("installationId")
    expect(json).not.toContain(INSTALLATION_ID)
    expect(json).not.toContain("deviceIdHash")
  })

  it("las rutas antiguas ZIP/identity YA NO EXISTEN (404 — flujo unificado)", async () => {
    const identity = await api("GET", "/api/license/identity", undefined, adminCookie)
    expect(identity.status).toBe(404)
    const imported = await api("POST", "/api/license/import", {}, adminCookie)
    expect(imported.status).toBe(404)
  })

  it("gating server-side en trial: crear usuarios → 403 con feature y contacto; backup → 403", async () => {
    const user = await api("POST", "/api/admin/users", { email: "x@y.z", name: "X", role: "VIEWER", password: "Clave123456" }, adminCookie)
    expect(user.status).toBe(403)
    expect(user.data.feature).toBe("users.management")
    expect(String(user.data.error)).toContain("52973387")

    const backup = await api("POST", "/api/admin/backup", {}, adminCookie)
    expect(backup.status).toBe(403)
    expect(backup.data.feature).toBe("backup.selfService")
  })

  it("editar la PROPIA cuenta sigue permitido en trial (seguridad personal no es premium)", async () => {
    // el admin puede cambiar su propio nombre (self-service)
    const me = await api("GET", "/api/auth/me", undefined, adminCookie)
    const uid = me.data?.user?.id
    const upd = await api("PUT", `/api/admin/users/${uid}`, { name: "Admin Renombrado" }, adminCookie)
    expect(upd.status).toBe(200)
  })
})

describe.skipIf(!canRun)("LICENSING integración — código de solicitud (paso 1 del flujo UX)", { timeout: 120_000 }, () => {
  it("POST /api/license/request-code SIN sesión → 401", async () => {
    const res = await api("POST", "/api/license/request-code", { customerName: "Lo D'Leo" })
    expect(res.status).toBe(401)
  })

  it("request-code sin customerName → 400", async () => {
    const res = await api("POST", "/api/license/request-code", { customerName: "" }, adminCookie)
    expect(res.status).toBe(400)
  })

  it("genera VLREQ2-… que el EMISOR abre con su clave X25519: customerName + binding OCULTOS al cliente", async () => {
    const { status, data } = await api("POST", "/api/license/request-code", { customerName: "Lo D'Leo" }, adminCookie)
    expect(status).toBe(200)
    expect(String(data.requestCode).startsWith("VLREQ2-")).toBe(true)
    expect(data.validForDays).toBe(15)

    // el cliente JAMÁS ve Installation ID / Disk ID en la respuesta
    const json = JSON.stringify(data)
    expect(json).not.toContain("installationId")
    expect(json).not.toContain(INSTALLATION_ID)
    expect(json).not.toContain("diskId")
    expect(json).not.toContain(DISK_ID)

    // el "emisor Android" (test) abre el código con la clave privada X25519
    const opened = openRequestCode(data.requestCode, reqKey.privateKey, {})
    expect(opened.payload.customerName).toBe("Lo D'Leo")
    expect(opened.payload.installationId).toBe(INSTALLATION_ID)
    expect(opened.payload.diskId).toBe(DISK_ID)
    expect(opened.payload.product).toBe("ViewLBA-Server")
    expect(opened.requestHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe.skipIf(!canRun)("LICENSING integración — activación por token (paso 2 del flujo UX)", { timeout: 120_000 }, () => {
  it("POST /api/license/activate SIN sesión → 401", async () => {
    const res = await api("POST", "/api/license/activate", { token: makeToken() })
    expect(res.status).toBe(401)
  })

  it("token vacío → 400 empty_token", async () => {
    const { status, data } = await api("POST", "/api/license/activate", { token: "" }, adminCookie)
    expect(status).toBe(400)
    expect(data.code).toBe("empty_token")
  })

  it("token manipulado (1 char) → 422 rechazado, nada guardado", async () => {
    const token = makeToken({ days: 90 })
    const pos = token.length - 3
    const flipped = token.slice(0, pos) + (token[pos] === "A" ? "B" : "A") + token.slice(pos + 1)
    const { status, data } = await activate(flipped)
    expect(status).toBe(422)
    expect(data.ok).toBe(false)
    expect(["bad_crc", "bad_frame", "bad_charset", "bad_signature"]).toContain(data.code)
  })

  it("token de OTRO equipo → 422 binding_mismatch con mensaje humano (sin datos técnicos)", async () => {
    const other = makeToken({ installationId: "VWLB-1111-2222-3333-4444" })
    const { status, data } = await activate(other)
    expect(status).toBe(422)
    expect(data.code).toBe("binding_mismatch")
    expect(String(data.reason)).toContain("NO corresponde a este equipo")
    expect(JSON.stringify(data)).not.toContain(INSTALLATION_ID)
  })

  it("token válido de 90 días → 200 ok con resumen seguro; la licencia queda ACTIVA", async () => {
    const { status, data } = await activate(makeToken({ days: 90, customerName: "Restaurante La Terraza" }))
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.summary.customerName).toBe("Restaurante La Terraza")
    expect(data.summary.durationDays).toBe(90)
    expect(data.summary.daysLeft).toBe(90)
    expect(JSON.stringify(data.summary)).not.toContain("installationId")
    expect(JSON.stringify(data.summary)).not.toContain("diskId")
  })

  it("re-pegar el MISMO token → idempotente (alreadyActive)", async () => {
    const token = makeToken({ days: 90 })
    const first = await activate(token)
    expect(first.status).toBe(200)
    const second = await activate(token)
    expect(second.status).toBe(200)
    expect(second.data.alreadyActive).toBe(true)
  })

  it("GET /api/license (admin) tras activar: ACTIVE con cliente, plan, fechas e historial — SIN identity", async () => {
    const { data } = await api("GET", "/api/license", undefined, adminCookie)
    expect(data.status).toBe("active")
    expect(data.license.customerName).toBe("Restaurante La Terraza")
    expect(data.license.plan).toBe("custom")
    expect(typeof data.license.startsAt).toBe("number")
    expect(data.history.length).toBeGreaterThanOrEqual(1)
    expect(data.history[0].current).toBe(true)
    // la vista admin YA NO expone identity (Installation/Disk ID ocultos)
    expect(data.identity).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain(INSTALLATION_ID)
    expect(JSON.stringify(data)).not.toContain("diskLabel")
  })

  it("el watermark DESAPARECE de /api/content al activar la licencia (refresco ETag)", async () => {
    await wait(3500) // superar el cache interno de 3s del endpoint público
    const bundle = await waitFor(
      async () => (await (await fetch(`${APP}/api/content`, { cache: "no-store" })).json()) as { license: { watermark: boolean } },
      (b) => b.license.watermark === false,
      15_000
    )
    expect(bundle.license.status).toBe("active")
  })

  it("gating deshabilitado con licencia: crear usuario → 200; backup → 200", async () => {
    const user = await api("POST", "/api/admin/users", { email: "operador@restaurante.com", name: "Operador", role: "OPERATOR", password: "Clave123456" }, adminCookie)
    expect(user.status).toBe(200)
    expect(user.data.item.email).toBe("operador@restaurante.com")

    const backup = await api("POST", "/api/admin/backup", {}, adminCookie)
    expect(backup.status).toBe(200)
    expect(backup.data.ok).toBe(true)
  })

  it("downgrade: token que vence antes que la activa → 422 y la activa sigue", async () => {
    const { data: before } = await api("GET", "/api/license", undefined, adminCookie)
    const activeExpiry = before.license.expiresAt as number
    const daysShort = Math.max(1, Math.floor((activeExpiry - Date.now()) / 86400000) - 30)
    const downgrade = makeToken({ days: daysShort, customerName: "Corta Vigencia" })
    const { status, data } = await activate(downgrade)
    expect(status).toBe(422)
    expect(data.code).toBe("downgrade")

    const { data: state } = await api("GET", "/api/license", undefined, adminCookie)
    expect(state.license.customerName).toBe("Restaurante La Terraza")
  })

  it("renovación: token posterior → 200 y el historial registra ambas", async () => {
    const renewal = makeToken({ days: 365, customerName: "Restaurante La Terraza" })
    const { status, data } = await activate(renewal)
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    const { data: state } = await api("GET", "/api/license", undefined, adminCookie)
    expect(state.status).toBe("active")
    expect(state.history.length).toBeGreaterThanOrEqual(2)
  })
})

describe.skipIf(!canRun)("LICENSING integración — auditoría", { timeout: 60_000 }, () => {
  it("los eventos de licencia quedan en el Log (license_activated / license_rejected) sin secretos", async () => {
    const { data } = await api("GET", "/api/admin/logs?limit=100", undefined, adminCookie)
    const actions = (data.items as { action: string }[]).map((l) => l.action)
    expect(actions).toContain("license_activated")
    expect(actions).toContain("license_rejected")
    expect(actions).toContain("trial_started")
    // ninguna clave/secret en los registros
    const dump = JSON.stringify(data)
    expect(dump).not.toContain(key.privateKey)
    expect(dump).not.toContain(reqKey.privateKey)
    expect(dump).not.toContain("signature")
  })
})
