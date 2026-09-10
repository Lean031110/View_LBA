/**
 * Tests: validador de licencias — LA MATRIZ DE SEGURIDAD (sección 27).
 *
 *  A) licencia válida → PASS
 *  B) modificar 1 byte → FAIL
 *  C) cambiar cliente → FAIL
 *  D) cambiar expiry → FAIL
 *  E) cambiar installationId → MISMATCH
 *  F) cambiar diskId → MISMATCH
 *  G) firmar con otra clave → FAIL
 *  H) licencia expirada → EXPIRED
 *  + producto incorrecto, schema incorrecto, fechas, gracia, plan, installPath
 */
import { describe, expect, it } from "bun:test"
import { validateLicense, licenseDaysLeft, licenseGraceHours } from "@/lib/licensing/validator"
import { generateLicenseKeyPair, signLicense } from "@/lib/licensing/crypto"
import { makeIdentity, makeSignedLicense, DAY_MS } from "./helpers"
import { buildLicense } from "../../tools/license-generator/lib"

const identity = makeIdentity()
const key = generateLicenseKeyPair()

describe("MATRIZ DE SEGURIDAD del validador", () => {
  it("A) licencia válida → valid:true, status active", () => {
    const license = makeSignedLicense(identity, key)
    const result = validateLicense(license, identity, { publicKey: key.publicKey, now: Date.now() })
    expect(result.valid).toBe(true)
    expect(result.status).toBe("active")
    expect(result.reasons).toEqual([])
    expect(result.license?.customerName).toBe("Leandro Bueno")
    expect(result.license?.plan).toBe("annual")
  })

  it("B) modificar 1 byte del JSON serializado → FAIL (firma rota)", () => {
    const license = makeSignedLicense(identity, key)
    const json = JSON.stringify(license)
    // cambiar un carácter del nombre (1 "byte")
    const tampered = JSON.parse(json.replace("Leandro", "Leandrp")) as typeof license
    const result = validateLicense(tampered, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.reasons[0]).toMatch(/firma digital inválida/i)
  })

  it("C) cambiar el cliente (re-firmado NO, solo editar) → FAIL", () => {
    const license = makeSignedLicense(identity, key)
    const tampered = { ...license, customerName: "Otro Cliente" }
    const result = validateLicense(tampered, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
  })

  it("C-bis) cambiar el cliente y RE-FIRMAR con la clave correcta pasa la firma (es el emisor legítimo) — el verificador solo confía en el emisor", () => {
    // Esto NO es un ataque: re-firmar requiere la clave privada del emisor.
    // Se documenta para dejar clara la frontera de confianza.
    const license = makeSignedLicense(identity, key, { customerName: "Cliente Renovado" })
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(true)
  })

  it("D) cambiar la fecha de vencimiento (sin re-firmar) → FAIL por firma", () => {
    const license = makeSignedLicense(identity, key)
    const tampered = { ...license, expiresAt: new Date(Date.now() + 400 * DAY_MS).toISOString() }
    const result = validateLicense(tampered, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
  })

  it("E) cambiar installationId (licencia de OTRO equipo) → MISMATCH", () => {
    const otherIdentity = makeIdentity()
    const license = makeSignedLicense(otherIdentity, key) // firmada para otro equipo
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("mismatch")
    expect(result.reasons[0]).toMatch(/otra instalación/i)
    expect(result.detail?.expectedInstallationId).toBe(identity.installationId)
    expect(result.detail?.foundInstallationId).toBe(otherIdentity.installationId)
  })

  it("F) cambiar diskId (licencia de OTRO disco) → MISMATCH", () => {
    const license = makeSignedLicense(identity, key, { diskId: "DSK-0000-0000-0000" })
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("mismatch")
    expect(result.reasons[0]).toMatch(/otro disco/i)
  })

  it("E+F) ambos → MISMATCH con 2 motivos", () => {
    const other = makeIdentity()
    const license = makeSignedLicense(other, key)
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.status).toBe("mismatch")
    expect(result.reasons).toHaveLength(2)
  })

  it("G) firmada con OTRA clave (emisor falso) → FAIL firma", () => {
    const attacker = generateLicenseKeyPair()
    const license = makeSignedLicense(identity, attacker) // firma del atacante
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.reasons[0]).toMatch(/firma digital inválida|no fue emitida por ViewLBA/i)
  })

  it("H) licencia vencida → EXPIRED (no invalid, no mismatch)", () => {
    const license = makeSignedLicense(identity, key, { startsAt: new Date(Date.now() - 60 * DAY_MS), days: 30 })
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("expired")
    expect(result.reasons[0]).toMatch(/vencida/i)
    // La licencia vencida muestra metadatos (cliente/plan) para la UI de renovación
    expect(result.license?.customerName).toBe("Leandro Bueno")
  })

  it("H-bis) vencida dentro de la ventana de gracia → GRACE (con LICENSE_GRACE_HOURS)", () => {
    const prevGrace = process.env.LICENSE_GRACE_HOURS
    process.env.LICENSE_GRACE_HOURS = "48"
    try {
      // venció hace 2 horas — dentro de la ventana de 48h
      const license = makeSignedLicense(identity, key, { startsAt: new Date(Date.now() - (30 * DAY_MS + 2 * 3600_000)), days: 30 })
      const result = validateLicense(license, identity, { publicKey: key.publicKey, now: Date.now() })
      expect(result.status).toBe("grace")
      expect(result.valid).toBe(false)
    } finally {
      if (prevGrace === undefined) delete process.env.LICENSE_GRACE_HOURS
      else process.env.LICENSE_GRACE_HOURS = prevGrace
    }
    expect(licenseGraceHours()).toBe(0)
  })

  it("licencia futura (start > now) → invalid con motivo claro", () => {
    const license = makeSignedLicense(identity, key, { startsAt: new Date(Date.now() + 10 * DAY_MS), days: 30 })
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.reasons[0]).toMatch(/aún no está vigente/i)
  })

  it("producto incorrecto → invalid (schema)", () => {
    const license = makeSignedLicense(identity, key)
    // re-firmar con producto cambiado (la firma pasa pero el semántico no)
    const { signature: _sig, ...payload } = license
    const badProduct = { ...payload, product: "OtroProducto" }
    const reSigned = { ...badProduct, signature: signLicense(badProduct, key.privateKey) }
    const result = validateLicense(reSigned, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.reasons[0]).toMatch(/product/i)
  })

  it("schema version incorrecto → invalid", () => {
    const license = makeSignedLicense(identity, key)
    const { signature: _sig, ...payload } = license
    const badSchema = { ...payload, schemaVersion: 99 }
    const reSigned = { ...badSchema, signature: signLicense(badSchema, key.privateKey) }
    const result = validateLicense(reSigned, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.reasons[0]).toMatch(/schemaVersion/i)
  })

  it("estructura no-licencia (sin signature) → invalid sin lanzar", () => {
    const result = validateLicense({ hola: "mundo" }, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.reasons[0]).toMatch(/estructura/i)
  })

  it("JSON con tipos corruptos (schemaVersion string) → invalid", () => {
    const license = makeSignedLicense(identity, key)
    const { signature: _sig, ...payload } = license
    const bad = { ...payload, schemaVersion: "1" }
    const reSigned = { ...bad, signature: signLicense(bad, key.privateKey) }
    const result = validateLicense(reSigned, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(false)
    expect(result.status).toBe("invalid")
  })

  it("plan mensual: 30 días exactos de vigencia", () => {
    const start = new Date("2026-09-10T00:00:00.000Z")
    const license = makeSignedLicense(identity, key, { plan: "monthly", startsAt: start, days: 30 })
    expect(new Date(license.expiresAt).toISOString()).toBe("2026-10-10T00:00:00.000Z")
    const at = Date.parse("2026-10-09T12:00:00Z")
    expect(validateLicense(license, identity, { publicKey: key.publicKey, now: at }).status).toBe("active")
    expect(validateLicense(license, identity, { publicKey: key.publicKey, now: Date.parse("2026-10-11T00:00:00Z") }).status).toBe("expired")
  })

  it("plan anual: 365 días exactos", () => {
    const start = new Date("2026-09-10T00:00:00.000Z")
    const license = makeSignedLicense(identity, key, { plan: "annual", startsAt: start, days: 365 })
    expect(new Date(license.expiresAt).toISOString()).toBe("2027-09-10T00:00:00.000Z")
  })

  it("installPath distinto → SOLO advertencia (binding opcional, no rompe)", () => {
    const license = makeSignedLicense(identity, key, { installPath: "D:\\OtraRuta" })
    const result = validateLicense(license, identity, { publicKey: key.publicKey })
    expect(result.valid).toBe(true)
    expect(result.detail?.installPathWarning).toMatch(/informativo/i)
  })

  it("licenseDaysLeft calcula días restantes con techo 0", () => {
    const future = new Date(Date.now() + 10 * DAY_MS).toISOString()
    expect(licenseDaysLeft(future)).toBe(10)
    const past = new Date(Date.now() - 5 * DAY_MS).toISOString()
    expect(licenseDaysLeft(past)).toBe(0)
  })
})

describe("coherencia generador ↔ validador (mismo código canónico)", () => {
  it("una licencia construida por el TOOL pasa el validador de la app", () => {
    const issuerKey = generateLicenseKeyPair()
    const license = buildLicense(
      {
        customerName: "Leandro Bueno",
        installationId: identity.installationId,
        diskId: identity.diskId,
        installPath: identity.installPath,
        plan: "monthly",
        startDate: new Date().toISOString().slice(0, 10),
      },
      issuerKey.privateKey
    )
    const result = validateLicense(license, identity, { publicKey: issuerKey.publicKey })
    expect(result.valid).toBe(true)
    expect(result.status).toBe("active")
    expect(result.license?.plan).toBe("monthly")
  })
})
