/**
 * ViewLBA License Generator — DEMO WEB (rama feature/license-demo-github-actions).
 *
 * Web INDEPENDIENTE del servidor principal (sección 23). Arquitectura:
 *
 *   navegador (UI estática)  →  este backend protegido  →  clave privada
 *
 * ⚠ La UI NUNCA ve la clave privada: solo envía el formulario y recibe el ZIP
 *   firmado. La clave vive en ESTE proceso.
 *
 * MODOS:
 *  · MODO ADMIN PRIVADO (default): clave real desde el env
 *      VIEWLBA_LICENSE_PRIVATE_KEY (obligatorio) y protección por token
 *      DEMO_ADMIN_TOKEN (recomendado; sin token solo escucha en localhost).
 *  · MODO DEMO (DEMO_MODE=true): par de claves EFÍMERO de demostración por
 *      arranque — licencias válidas solo contra la clave pública de esta
 *      sesión, jamás contra la de producción.
 *
 * Arranque: bun license-demo/server.ts   (LICENSE_DEMO_PORT=3210 default)
 */
import { createPublicKey } from "node:crypto"
import {
  generateLicenseKeyPair,
  signLicense,
  verifyLicenseSignature,
  buildZip,
  readZip,
  findZipEntry,
  validateLicense,
  newLicenseId,
} from "../src/lib/licensing/index"
import type { LicensePayload, SignedLicense, LicensePlan } from "../src/lib/licensing/types"
import { validateGenerateInput, buildReadme, slugifyCustomer, ALL_FEATURES } from "../tools/license-generator/lib"

const CONTACT = "52973387"
const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Configuración de modo
// ---------------------------------------------------------------------------

export interface DemoServerConfig {
  mode: "demo" | "admin"
  /** Clave privada activa (admin: del env; demo: efímera). */
  privateKey: string
  /** Clave pública correspondiente (derivada o efímera). */
  publicKey: string
  /** Token de autorización (admin con token). null = sin protección. */
  adminToken: string | null
  port: number
  /** Host de escucha. */
  hostname: string
}

/** Deriva la clave pública Ed25519 desde la privada (para mostrar/verificar). */
function publicKeyFromPrivate(privB64url: string): string | null {
  try {
    const priv = Buffer.from(privB64url, "base64url")
    if (priv.length !== 32) return null
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), priv])
    const keyObj = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
    const spki = keyObj.export({ format: "der", type: "spki" }) as Buffer
    return spki.subarray(spki.length - 32).toString("base64url")
  } catch {
    return null
  }
}

/** Resuelve la configuración desde el entorno (arranque real). */
export function resolveConfigFromEnv(): DemoServerConfig {
  const demoMode = process.env.DEMO_MODE === "true" || process.env.DEMO_MODE === "1"
  const port = Number(process.env.LICENSE_DEMO_PORT ?? 3210) || 3210
  const envKey = process.env.VIEWLBA_LICENSE_PRIVATE_KEY?.trim()

  if (demoMode) {
    const pair = generateLicenseKeyPair()
    return {
      mode: "demo",
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      adminToken: null,
      port,
      hostname: process.env.LICENSE_DEMO_BIND ?? "0.0.0.0",
    }
  }

  if (!envKey) {
    console.error(
      "✗ MODO ADMIN: falta VIEWLBA_LICENSE_PRIVATE_KEY.\n" +
        "   Opciones:\n" +
        "   · exporta VIEWLBA_LICENSE_PRIVATE_KEY=\"<base64url>\"  (emisión real)\n" +
        "   · DEMO_MODE=true                                          (demo pública con clave efímera)\n"
    )
    process.exit(1)
  }
  const derived = publicKeyFromPrivate(envKey)
  if (!derived) {
    console.error("✗ VIEWLBA_LICENSE_PRIVATE_KEY mal formada (se esperaban 32 bytes en base64url)")
    process.exit(1)
  }
  const token = process.env.DEMO_ADMIN_TOKEN?.trim() || null
  return {
    mode: "admin",
    privateKey: envKey,
    publicKey: derived,
    adminToken: token,
    port,
    // sin token → SOLO localhost (no exponer un emisor de licencias abierto)
    hostname: process.env.LICENSE_DEMO_BIND ?? (token ? "0.0.0.0" : "127.0.0.1"),
  }
}

// ---------------------------------------------------------------------------
// Rate limit simple (en memoria, por IP)
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, { count: number; reset: number }>()
function rateLimited(ip: string, maxPerMinute = 20): boolean {
  const now = Date.now()
  const b = rateBuckets.get(ip)
  if (!b || now > b.reset) {
    rateBuckets.set(ip, { count: 1, reset: now + 60_000 })
    return false
  }
  b.count += 1
  return b.count > maxPerMinute
}

// ---------------------------------------------------------------------------
// Generación (reusa las MISMAS validaciones/README del CLI)
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  customerName: string
  installationId: string
  diskId: string
  installPath: string
  plan: LicensePlan
  startDate: string
  features?: Record<string, boolean>
  licenseId?: string
}

function buildDemoLicense(req: GenerateRequest, privateKey: string): SignedLicense {
  const start = new Date(`${req.startDate}T00:00:00.000Z`)
  const durationDays = req.plan === "annual" ? 365 : 30
  const payload: LicensePayload = {
    schemaVersion: 1,
    licenseId: req.licenseId ?? newLicenseId(),
    customerName: req.customerName.trim(),
    plan: req.plan,
    issuedAt: new Date().toISOString(),
    startsAt: start.toISOString(),
    expiresAt: new Date(start.getTime() + durationDays * DAY_MS).toISOString(),
    deviceId: req.installationId.trim().toUpperCase(),
    diskId: req.diskId.trim().toUpperCase(),
    installPath: req.installPath.trim(),
    product: "ViewLBA-Server",
    features: req.features ?? { ...ALL_FEATURES },
  }
  return { ...payload, signature: signLicense(payload, privateKey) }
}

function zipOf(license: SignedLicense): Buffer {
  return buildZip([
    { name: "license.json", data: Buffer.from(JSON.stringify(license, null, 2), "utf8") },
    { name: "README.txt", data: Buffer.from(buildReadme(license), "utf8") },
  ])
}

/** Lee license.json desde un ZIP en buffer o un JSON en crudo. */
function readLicenseFromBuffer(buf: Buffer): SignedLicense {
  if (buf.subarray(0, 2).toString("ascii") === "PK") {
    const entries = readZip(buf)
    const entry = findZipEntry(entries, "license.json")
    if (!entry) throw new Error("El ZIP no contiene license.json")
    return JSON.parse(entry.data.toString("utf8")) as SignedLicense
  }
  return JSON.parse(buf.toString("utf8")) as SignedLicense
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const UI_DIR = join(import.meta.dir, "ui")

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  })
}

export interface DemoServer {
  port: number
  mode: "demo" | "admin"
  publicKey: string
  close(): void
}

/** Crea el servidor de la demo (tests: port 0 = efímero). */
export function createLicenseDemoServer(cfg: DemoServerConfig): DemoServer {
  const authorized = (req: Request): boolean => {
    if (cfg.mode === "demo" || !cfg.adminToken) return true
    const header = req.headers.get("authorization") ?? ""
    return header === `Bearer ${cfg.adminToken}`
  }

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.hostname,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"

      // ---------- estáticos de la UI ----------
      if (req.method === "GET") {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const html = readFileSync(join(UI_DIR, "index.html"), "utf8")
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }
        if (url.pathname === "/styles.css" && existsSync(join(UI_DIR, "styles.css"))) {
          return new Response(readFileSync(join(UI_DIR, "styles.css"), "utf8"), { headers: { "Content-Type": "text/css; charset=utf-8" } })
        }
        if (url.pathname === "/app.js" && existsSync(join(UI_DIR, "app.js"))) {
          return new Response(readFileSync(join(UI_DIR, "app.js"), "utf8"), { headers: { "Content-Type": "text/javascript; charset=utf-8" } })
        }
        if (url.pathname === "/api/config") {
          return json(200, {
            mode: cfg.mode,
            protected: cfg.adminToken != null,
            // la pública SÍ es pública: permite a la UI verificar localmente
            publicKey: cfg.publicKey,
            contact: CONTACT,
          })
        }
        if (url.pathname === "/api/health") {
          return json(200, { ok: true, mode: cfg.mode })
        }
        return json(404, { error: "No encontrado" })
      }

      // ---------- API (POST) ----------
      if (req.method !== "POST") return json(405, { error: "Método no permitido" })
      if (rateLimited(ip)) return json(429, { error: "Demasiadas peticiones — espera un minuto" })
      if (!authorized(req)) return json(401, { error: "No autorizado: falta el token del administrador" })

      let body: Record<string, unknown>
      try {
        const text = await req.text()
        if (text.length > 2 * 1024 * 1024) return json(413, { error: "Cuerpo demasiado grande" })
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        return json(400, { error: "JSON inválido" })
      }

      try {
        // ---------- GENERAR ----------
        if (url.pathname === "/api/generate") {
          const genReq: GenerateRequest = {
            customerName: String(body.customerName ?? ""),
            installationId: String(body.installationId ?? ""),
            diskId: String(body.diskId ?? ""),
            installPath: String(body.installPath ?? ""),
            plan: (body.plan === "annual" ? "annual" : body.plan === "monthly" ? "monthly" : "") as LicensePlan,
            startDate: String(body.startDate ?? ""),
            features: (body.features as Record<string, boolean> | undefined) ?? undefined,
            licenseId: body.licenseId ? String(body.licenseId) : undefined,
          }
          const errors = validateGenerateInput(genReq)
          if (errors.length > 0) return json(422, { ok: false, reasons: errors })

          const license = buildDemoLicense(genReq, cfg.privateKey)
          // auto-verificación ANTES de entregar (jamás emitir algo inválido)
          if (!verifyLicenseSignature(license, cfg.publicKey)) {
            return json(500, { ok: false, reasons: ["Error interno: auto-verificación de firma falló"] })
          }
          const zip = zipOf(license)
          console.log(
            `[license-demo:${cfg.mode}] emitida ${license.licenseId} · ${license.customerName} · ${license.plan} · ${license.startsAt.slice(0, 10)} → ${license.expiresAt.slice(0, 10)} · ${license.deviceId} ${license.diskId}`
          )
          return json(200, {
            ok: true,
            fileName: `ViewLBA-License-${slugifyCustomer(license.customerName)}-${license.startsAt.slice(0, 10).replace(/-/g, "")}.zip`,
            zipBase64: zip.toString("base64"),
            license,
            summary: {
              licenseId: license.licenseId,
              customerName: license.customerName,
              plan: license.plan,
              startsAt: license.startsAt,
              expiresAt: license.expiresAt,
              daysLeft: Math.max(0, Math.ceil((Date.parse(license.expiresAt) - Date.now()) / DAY_MS)),
            },
          })
        }

        // ---------- RENOVAR ----------
        if (url.pathname === "/api/renew") {
          const fileB64 = String(body.fileBase64 ?? "")
          const plan = (body.plan === "annual" ? "annual" : body.plan === "monthly" ? "monthly" : "") as LicensePlan
          const startDate = String(body.startDate ?? new Date().toISOString().slice(0, 10))
          if (!fileB64) return json(422, { ok: false, reasons: ["Adjunta la licencia actual (fileBase64)"] })
          if (!plan) return json(422, { ok: false, reasons: ["Plan inválido: monthly | annual"] })

          let current: SignedLicense
          try {
            current = readLicenseFromBuffer(Buffer.from(fileB64, "base64"))
          } catch (e) {
            return json(422, { ok: false, reasons: [`No se pudo leer la licencia: ${(e as Error).message}`] })
          }
          if (!verifyLicenseSignature(current, cfg.publicKey)) {
            return json(422, { ok: false, reasons: ["La licencia de origen NO pasa la verificación de firma — no se renueva"] })
          }

          const req2: GenerateRequest = {
            customerName: current.customerName,
            installationId: current.deviceId,
            diskId: current.diskId,
            installPath: current.installPath,
            plan,
            startDate,
            features: current.features,
          }
          const errors = validateGenerateInput(req2)
          if (errors.length > 0) return json(422, { ok: false, reasons: errors })

          const renewed = buildDemoLicense(req2, cfg.privateKey)
          if (Date.parse(renewed.expiresAt) < Date.parse(current.expiresAt)) {
            return json(422, { ok: false, reasons: ["La renovación vence antes que la licencia actual (downgrade no permitido)"] })
          }
          if (!verifyLicenseSignature(renewed, cfg.publicKey)) {
            return json(500, { ok: false, reasons: ["Error interno: auto-verificación de firma falló"] })
          }
          const zip = zipOf(renewed)
          console.log(`[license-demo:${cfg.mode}] renovada ${current.licenseId} → ${renewed.licenseId} · vence ${renewed.expiresAt.slice(0, 10)}`)
          return json(200, {
            ok: true,
            fileName: `ViewLBA-License-${slugifyCustomer(renewed.customerName)}-${renewed.startsAt.slice(0, 10).replace(/-/g, "")}.zip`,
            zipBase64: zip.toString("base64"),
            license: renewed,
            summary: {
              licenseId: renewed.licenseId,
              customerName: renewed.customerName,
              plan: renewed.plan,
              startsAt: renewed.startsAt,
              expiresAt: renewed.expiresAt,
              daysLeft: Math.max(0, Math.ceil((Date.parse(renewed.expiresAt) - Date.now()) / DAY_MS)),
            },
          })
        }

        // ---------- VERIFICAR ----------
        if (url.pathname === "/api/verify") {
          const fileB64 = String(body.fileBase64 ?? "")
          const installationId = body.installationId ? String(body.installationId).toUpperCase() : null
          const diskId = body.diskId ? String(body.diskId).toUpperCase() : null
          if (!fileB64) return json(422, { ok: false, reasons: ["Adjunta la licencia (fileBase64)"] })
          let license: SignedLicense
          try {
            license = readLicenseFromBuffer(Buffer.from(fileB64, "base64"))
          } catch (e) {
            return json(422, { ok: false, reasons: [`No se pudo leer la licencia: ${(e as Error).message}`] })
          }
          const signatureOk = verifyLicenseSignature(license, cfg.publicKey)
          const daysLeft = Math.max(0, Math.ceil((Date.parse(license.expiresAt) - Date.now()) / DAY_MS))
          const binding: { installationId?: "match" | "mismatch"; diskId?: "match" | "mismatch" } = {}
          if (installationId) binding.installationId = license.deviceId.toUpperCase() === installationId ? "match" : "mismatch"
          if (diskId) binding.diskId = license.diskId.toUpperCase() === diskId ? "match" : "mismatch"
          return json(200, {
            ok: true,
            signatureOk,
            expired: Date.parse(license.expiresAt) < Date.now(),
            daysLeft,
            binding,
            license: {
              licenseId: license.licenseId,
              customerName: license.customerName,
              plan: license.plan,
              startsAt: license.startsAt,
              expiresAt: license.expiresAt,
              deviceId: license.deviceId,
              diskId: license.diskId,
              installPath: license.installPath,
            },
          })
        }

        return json(404, { error: "Endpoint no encontrado" })
      } catch (e) {
        return json(500, { error: `Error interno: ${(e as Error).message}` })
      }
    },
  })

  return { port: server.port, mode: cfg.mode, publicKey: cfg.publicKey, close: () => server.stop(true) }
}

// ---------------------------------------------------------------------------
// Arranque directo (no en tests)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const cfg = resolveConfigFromEnv()
  const server = createLicenseDemoServer(cfg)
  const tokenNote = cfg.adminToken ? " (protegido con DEMO_ADMIN_TOKEN)" : " (SIN token — solo localhost)"
  console.log("")
  console.log("┌─────────────────────────────────────────────────────────────┐")
  console.log("   ViewLBA License Generator — web de emisión")
  console.log(`   Modo:  ${cfg.mode === "demo" ? "DEMO (clave efímera de prueba — licencias NO válidas en producción)" : "ADMIN PRIVADO" + tokenNote}`)
  console.log(`   URL:   http://${cfg.hostname === "0.0.0.0" ? "<ip-de-esta-máquina>" : cfg.hostname}:${server.port}/`)
  console.log(`   Clave pública activa: ${cfg.publicKey.slice(0, 20)}…`)
  console.log(`   Contacto: ${CONTACT}`)
  console.log("   La clave privada NUNCA se envía al navegador.")
  console.log("└─────────────────────────────────────────────────────────────┘")
  console.log("")
  if (cfg.mode === "admin" && !cfg.adminToken) {
    console.warn("⚠ Sin DEMO_ADMIN_TOKEN el servidor solo escucha 127.0.0.1. Para acceso remoto seguro, define un token.")
  }
  // keep alive
  setInterval(() => {}, 1 << 30)
}
