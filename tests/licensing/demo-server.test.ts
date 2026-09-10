/**
 * Tests: servidor web del License Generator (license-demo/server.ts).
 *
 * Invariante CRÍTICA de seguridad (sección 23): la clave privada NUNCA
 * aparece en ninguna respuesta de la API (la UI jamás la recibe).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createLicenseDemoServer, type DemoServerConfig } from "../../license-demo/server"
import { generateLicenseKeyPair, verifyLicenseSignature, readZip, findZipEntry, buildZip } from "@/lib/licensing/index"

const pair = generateLicenseKeyPair() // clave efímera de test (NUNCA la de producción)

const demoConfig: DemoServerConfig = {
  mode: "demo",
  privateKey: pair.privateKey,
  publicKey: pair.publicKey,
  adminToken: null,
  port: 0, // efímero
  hostname: "127.0.0.1",
}

const adminConfig: DemoServerConfig = {
  mode: "admin",
  privateKey: pair.privateKey,
  publicKey: pair.publicKey,
  adminToken: "token-super-secreto-de-test",
  port: 0,
  hostname: "127.0.0.1",
}

let demo: ReturnType<typeof createLicenseDemoServer>
let admin: ReturnType<typeof createLicenseDemoServer>

beforeAll(() => {
  demo = createLicenseDemoServer(demoConfig)
  admin = createLicenseDemoServer(adminConfig)
})

afterAll(() => {
  demo?.close()
  admin?.close()
})

const BASE = () => `http://127.0.0.1:${demo.port}`
const ADMIN_BASE = () => `http://127.0.0.1:${admin.port}`

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {}
  return { status: res.status, data }
}

/** INVARIANTE: ninguna respuesta contiene la clave privada. */
function assertNoPrivateKey(data: unknown) {
  expect(JSON.stringify(data)).not.toContain(pair.privateKey)
}

const VALID_INPUT = {
  customerName: "Leandro Bueno",
  installationId: "VWLB-8F2A-91CD-2D31-77AA",
  diskId: "DSK-A5ED-432A-37DD",
  installPath: "C:\\PantallaRestaurante",
  plan: "annual",
  startDate: new Date().toISOString().slice(0, 10),
}

describe("license-demo — config y estáticos", () => {
  it("GET /api/config expone modo, clave pública y contacto — sin clave privada", async () => {
    const res = await fetch(`${BASE()}/api/config`)
    const data = (await res.json()) as { mode: string; publicKey: string; contact: string }
    expect(data.mode).toBe("demo")
    expect(data.publicKey).toBe(pair.publicKey)
    expect(data.contact).toBe("52973387")
    assertNoPrivateKey(data)
  })

  it("GET / sirve la UI (HTML con el título del generador)", async () => {
    const res = await fetch(`${BASE()}/`)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain("ViewLBA License Generator")
    expect(html).toContain("GENERAR LICENCIA")
  })

  it("GET /api/health responde ok", async () => {
    const res = await fetch(`${BASE()}/api/health`)
    expect((await res.json()).ok).toBe(true)
  })
})

describe("license-demo — generación", () => {
  it("input válido → ZIP firmado verificable + resumen + nombre de archivo correcto", async () => {
    const { status, data } = await post(BASE(), "/api/generate", VALID_INPUT)
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    assertNoPrivateKey(data)

    expect(data.fileName).toMatch(/^ViewLBA-License-Leandro-Bueno-\d{8}\.zip$/)
    expect(data.summary.plan).toBe("annual")
    expect(data.summary.daysLeft).toBe(365)

    // el ZIP es real y la licencia dentro verifica contra la clave pública
    const zip = Buffer.from(data.zipBase64, "base64")
    const entries = readZip(zip)
    const licenseEntry = findZipEntry(entries, "license.json")
    expect(licenseEntry).not.toBeNull()
    const license = JSON.parse(licenseEntry!.data.toString("utf8"))
    expect(verifyLicenseSignature(license, pair.publicKey)).toBe(true)
    expect(license.deviceId).toBe(VALID_INPUT.installationId)
    expect(license.diskId).toBe(VALID_INPUT.diskId)
    // incluye README con contacto
    const readme = findZipEntry(entries, "README.txt")
    expect(readme!.data.toString("utf8")).toContain("52973387")
  })

  it("inputs inválidos → 422 con motivos (nada se emite)", async () => {
    const { status, data } = await post(BASE(), "/api/generate", {
      ...VALID_INPUT,
      customerName: "",
      installationId: "no-valido",
      diskId: "tampoco",
      plan: "semanal",
      startDate: "31-12-2026",
    })
    expect(status).toBe(422)
    expect(data.ok).toBe(false)
    expect(data.reasons.length).toBeGreaterThanOrEqual(4)
    expect(data.reasons.join(" ")).toMatch(/Installation ID/i)
    assertNoPrivateKey(data)
  })

  it("la vigencia respeta el plan: monthly → 30 días", async () => {
    const { data } = await post(BASE(), "/api/generate", { ...VALID_INPUT, plan: "monthly" })
    const license = data.license
    const days = (Date.parse(license.expiresAt) - Date.parse(license.startsAt)) / 86400000
    expect(days).toBe(30)
  })
})

describe("license-demo — MODO ADMIN PRIVADO (token)", () => {
  it("sin token → 401; con token → 200", async () => {
    const noAuth = await post(ADMIN_BASE(), "/api/generate", VALID_INPUT)
    expect(noAuth.status).toBe(401)
    expect(noAuth.data.error).toMatch(/token/i)

    const withAuth = await post(ADMIN_BASE(), "/api/generate", VALID_INPUT, {
      Authorization: "Bearer token-super-secreto-de-test",
    })
    expect(withAuth.status).toBe(200)
    expect(withAuth.data.ok).toBe(true)
    assertNoPrivateKey(withAuth.data)
  })

  it("GET /api/config en modo admin lo reporta y NO incluye la clave privada", async () => {
    const res = await fetch(`${ADMIN_BASE()}/api/config`)
    const data = (await res.json()) as { mode: string; protected: boolean }
    expect(data.mode).toBe("admin")
    expect(data.protected).toBe(true)
    assertNoPrivateKey(data)
  })
})

describe("license-demo — verificación y renovación", () => {
  it("verificar un ZIP emitido → firma OK y binding match; manipulado → firma inválida", async () => {
    const gen = (await post(BASE(), "/api/generate", VALID_INPUT)).data
    const verify = await post(BASE(), "/api/verify", {
      fileBase64: gen.zipBase64,
      installationId: VALID_INPUT.installationId,
      diskId: VALID_INPUT.diskId,
    })
    expect(verify.data.signatureOk).toBe(true)
    expect(verify.data.expired).toBe(false)
    expect(verify.data.binding.installationId).toBe("match")
    expect(verify.data.binding.diskId).toBe("match")
    assertNoPrivateKey(verify.data)

    // licencia manipulada (cliente cambiado tras firmar)
    const tampered = { ...gen.license, customerName: "Falsificado" }
    const tamperedZip = buildZip([{ name: "license.json", data: Buffer.from(JSON.stringify(tampered)) }])
    const verify2 = await post(BASE(), "/api/verify", { fileBase64: tamperedZip.toString("base64") })
    expect(verify2.data.signatureOk).toBe(false)
  })

  it("renovar desde el ZIP emitido → nueva licencia con el MISMO binding", async () => {
    const gen = (await post(BASE(), "/api/generate", { ...VALID_INPUT, plan: "monthly" })).data
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const renew = await post(BASE(), "/api/renew", { fileBase64: gen.zipBase64, plan: "annual", startDate: future })
    expect(renew.status).toBe(200)
    expect(renew.data.ok).toBe(true)
    expect(renew.data.license.deviceId).toBe(VALID_INPUT.installationId)
    expect(renew.data.license.diskId).toBe(VALID_INPUT.diskId)
    expect(renew.data.license.licenseId).not.toBe(gen.license.licenseId)
    // vence después que la original (365 días desde +30)
    expect(Date.parse(renew.data.license.expiresAt)).toBeGreaterThan(Date.parse(gen.license.expiresAt))
    assertNoPrivateKey(renew.data)
  })

  it("renovación que acorta la vigencia (downgrade) → 422", async () => {
    const gen = (await post(BASE(), "/api/generate", { ...VALID_INPUT, plan: "annual" })).data
    const renew = await post(BASE(), "/api/renew", { fileBase64: gen.zipBase64, plan: "monthly", startDate: new Date().toISOString().slice(0, 10) })
    expect(renew.status).toBe(422)
    expect(renew.data.reasons[0]).toMatch(/downgrade/i)
  })

  it("renovar desde una licencia manipulada → 422 (firma de origen inválida)", async () => {
    const gen = (await post(BASE(), "/api/generate", VALID_INPUT)).data
    const tampered = { ...gen.license, expiresAt: "2030-01-01T00:00:00.000Z" }
    const tamperedZip = buildZip([{ name: "license.json", data: Buffer.from(JSON.stringify(tampered)) }])
    const renew = await post(BASE(), "/api/renew", { fileBase64: tamperedZip.toString("base64"), plan: "annual" })
    expect(renew.status).toBe(422)
    expect(renew.data.reasons[0]).toMatch(/verificación de firma/i)
  })
})

describe("license-demo — robustez", () => {
  it("JSON inválido → 400; endpoint desconocido → 404", async () => {
    const res = await fetch(`${BASE()}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{no json" })
    expect(res.status).toBe(400)

    const nf = await post(BASE(), "/api/no-existe", {})
    expect(nf.status).toBe(404)
  })

  it("rate limit: más de 20 POST/min → 429", async () => {
    let got429 = false
    for (let i = 0; i < 24 && !got429; i++) {
      const r = await post(BASE(), "/api/verify", { fileBase64: "" }) // peticiones baratas inválidas
      if (r.status === 429) got429 = true
    }
    expect(got429).toBe(true)
  })
})
