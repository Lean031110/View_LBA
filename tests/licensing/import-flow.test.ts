/**
 * Tests: flujo de importación ZIP → validación TOTAL → guardado (sección 15/18).
 * Con MemoryStore (sin DB) e identidad sintética inyectada.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { importLicenseZip } from "@/lib/licensing/index"
import { MemoryLicenseStore } from "@/lib/licensing/storage"
import { generateLicenseKeyPair } from "@/lib/licensing/crypto"
import { buildZip } from "@/lib/licensing/zip"
import { makeIdentity, makeSignedLicense, makeLicenseZip, DAY_MS } from "./helpers"

let identity: ReturnType<typeof makeIdentity>
let key: ReturnType<typeof generateLicenseKeyPair>
let store: MemoryLicenseStore

beforeEach(() => {
  identity = makeIdentity()
  key = generateLicenseKeyPair()
  store = new MemoryLicenseStore()
  process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdef"
})



describe("importLicenseZip — aceptación", () => {
  it("ZIP válido → ok, guarda la licencia y añade historial", async () => {
    const license = makeSignedLicense(identity, key, { days: 30, plan: "monthly" })
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.summary?.customerName).toBe("Leandro Bueno")
    expect(result.summary?.plan).toBe("monthly")
    expect(result.summary?.daysLeft).toBe(30)

    const record = await store.getLicenseRecord()
    expect(record?.license.licenseId).toBe(license.licenseId)
    expect(record?.importedBy).toBe("sistema")
    expect(store.history).toHaveLength(1)
    expect(store.history[0].current).toBe(true)
    expect(store.history[0].licenseId).toBe(license.licenseId)
  })

  it("README.txt incluido en el ZIP (sección 5: contenido del paquete)", async () => {
    const license = makeSignedLicense(identity, key)
    // makeLicenseZip ya incluye README.txt; verificamos que la importación
    // no depende de él (extrae solo license.json)
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(true)
  })
})

describe("importLicenseZip — rechazos (SOLO guardar si TODO pasa)", () => {
  it("no es un ZIP → rechazado y NADA guardado", async () => {
    const result = await importLicenseZip(Buffer.from("archivo de texto cualquiera"), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/ZIP/)
    expect(await store.getLicenseRecord()).toBeNull()
    expect(store.history).toHaveLength(0)
  })

  it("ZIP sin license.json → rechazado", async () => {
    const zip = buildZip([{ name: "README.txt", data: Buffer.from("sin licencia") }])
    const result = await importLicenseZip(zip, { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/license\.json/)
  })

  it("license.json no-JSON → rechazado", async () => {
    const zip = buildZip([{ name: "license.json", data: Buffer.from("{esto no es json") }])
    const result = await importLicenseZip(zip, { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/JSON/)
  })

  it("ZIP corrupto (CRC) → rechazado", async () => {
    const zip = makeLicenseZip(makeSignedLicense(identity, key))
    // corromper el área de DATOS (local header 30 + nombre "license.json" 14)
    zip[30 + "license.json".length] ^= 0xff
    const result = await importLicenseZip(zip, { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/corrupto|inválido/i)
  })

  it("licencia con firma de OTRA clave → rechazada (firma)", async () => {
    const attacker = generateLicenseKeyPair()
    const license = makeSignedLicense(identity, attacker)
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/firma/i)
    expect(await store.getLicenseRecord()).toBeNull()
  })

  it("licencia de OTRO equipo (installationId) → MISMATCH, no se guarda", async () => {
    const other = makeIdentity()
    const license = makeSignedLicense(other, key)
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/otra instalación/i)
    expect(await store.getLicenseRecord()).toBeNull()
  })

  it("licencia de OTRO disco (diskId) → MISMATCH, no se guarda (sección 19)", async () => {
    const license = makeSignedLicense(identity, key, { diskId: "DSK-AAAA-BBBB-CCCC" })
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/otro disco/i)
  })

  it("licencia VENCIDA → rechazada (expired) y no se guarda", async () => {
    const license = makeSignedLicense(identity, key, { startsAt: new Date(Date.now() - 60 * DAY_MS), days: 30 })
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/vencida/i)
  })

  it("producto incorrecto → rechazada", async () => {
    const license = makeSignedLicense(identity, key)
    const { signature, ...payload } = license as { signature: string } & Record<string, unknown>
    const badProduct = { ...payload, product: "ProductoAjeno" }
    const { signLicense } = await import("@/lib/licensing/crypto")
    const bad = { ...badProduct, signature: signLicense(badProduct as never, key.privateKey) }
    const result = await importLicenseZip(makeLicenseZip(bad as never), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/product/i)
  })
})

describe("importLicenseZip — renovaciones y anti-downgrade (sección 18)", () => {
  it("renovación (vence después) → reemplaza y el historial conserva ambas", async () => {
    const first = makeSignedLicense(identity, key, { days: 30, plan: "monthly" })
    await importLicenseZip(makeLicenseZip(first), { store, identity, publicKey: key.publicKey, silent: true })

    const renewal = makeSignedLicense(identity, key, { days: 365, plan: "annual" })
    const result = await importLicenseZip(makeLicenseZip(renewal), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(true)

    const record = await store.getLicenseRecord()
    expect(record?.license.licenseId).toBe(renewal.licenseId)
    expect(store.history).toHaveLength(2)
    expect(store.history.find((h) => h.licenseId === first.licenseId)?.current).toBe(false)
    expect(store.history.find((h) => h.licenseId === renewal.licenseId)?.current).toBe(true)
  })

  it("downgrade (vence ANTES que la activa) → rechazado", async () => {
    const active = makeSignedLicense(identity, key, { days: 365, plan: "annual" })
    await importLicenseZip(makeLicenseZip(active), { store, identity, publicKey: key.publicKey, silent: true })

    const shorter = makeSignedLicense(identity, key, { days: 30, plan: "monthly" })
    const result = await importLicenseZip(makeLicenseZip(shorter), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(false)
    expect(result.reasons[0]).toMatch(/downgrade/i)
    // la activa sigue siendo la anual
    expect((await store.getLicenseRecord())?.license.licenseId).toBe(active.licenseId)
  })

  it("re-importar la MISMA licencia (idéntico licenseId) → permitido (idempotente)", async () => {
    const license = makeSignedLicense(identity, key, { days: 365 })
    await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    const result = await importLicenseZip(makeLicenseZip(license), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(true)
  })

  it("con licencia VENCIDA guardada, una nueva vigente (aunque sea más corta) → permitida", async () => {
    const expired = makeSignedLicense(identity, key, { startsAt: new Date(Date.now() - 60 * DAY_MS), days: 30 })
    await importLicenseZip(makeLicenseZip(expired), { store, identity, publicKey: key.publicKey, silent: true })

    const fresh = makeSignedLicense(identity, key, { days: 30, plan: "monthly" })
    const result = await importLicenseZip(makeLicenseZip(fresh), { store, identity, publicKey: key.publicKey, silent: true })
    expect(result.ok).toBe(true)
  })
})
