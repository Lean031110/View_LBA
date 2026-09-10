/**
 * Tests: criptografía Ed25519 de licencias (sección 27).
 * Claves efímeras generadas EN RUNTIME — nunca claves reales en el repo.
 */
import { describe, expect, it } from "bun:test"
import {
  generateLicenseKeyPair,
  signLicense,
  verifyLicenseSignature,
  isValidRawKey,
  newLicenseId,
  randomHex,
  sha256Hex,
} from "@/lib/licensing/crypto"
import { canonicalizeLicensePayload } from "@/lib/licensing/canonical"
import { makeSignedLicense, makeIdentity } from "./helpers"

const basePayload = {
  schemaVersion: 1,
  licenseId: "VLBA-aaaaaaaaaaaa",
  customerName: "Leandro Bueno",
  plan: "monthly",
  issuedAt: "2026-09-10T00:00:00.000Z",
  startsAt: "2026-09-10T00:00:00.000Z",
  expiresAt: "2026-10-10T00:00:00.000Z",
  deviceId: "VWLB-0094-6114-A3A4-8905",
  diskId: "DSK-A5ED-432A-37DD",
  installPath: "c:/pantallarestaurante",
  product: "ViewLBA-Server",
  features: { "users.management": true },
}

describe("generateLicenseKeyPair", () => {
  it("produce claves Ed25519 crudas válidas (base64url, 32 bytes)", () => {
    const { publicKey, privateKey } = generateLicenseKeyPair()
    expect(isValidRawKey(publicKey)).toBe(true)
    expect(isValidRawKey(privateKey)).toBe(true)
  })

  it("cada par es distinto (aleatoriedad real)", () => {
    const a = generateLicenseKeyPair()
    const b = generateLicenseKeyPair()
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.privateKey).not.toBe(b.privateKey)
  })
})

describe("signLicense / verifyLicenseSignature", () => {
  it("ida y vuelta: firma sobre payload canónico y verificación OK", () => {
    const key = generateLicenseKeyPair()
    const signature = signLicense(basePayload, key.privateKey)
    expect(typeof signature).toBe("string")
    // 64 bytes → base64url sin padding = 86 chars
    expect(signature.length).toBe(86)
    const license = { ...basePayload, signature }
    expect(verifyLicenseSignature(license, key.publicKey)).toBe(true)
  })

  it("la firma cubre TODO el payload: cambiar 1 campo rompe la verificación", () => {
    const key = generateLicenseKeyPair()
    const signature = signLicense(basePayload, key.privateKey)
    const license = { ...basePayload, signature }
    expect(verifyLicenseSignature({ ...license, customerName: "Otra Persona" }, key.publicKey)).toBe(false)
    expect(verifyLicenseSignature({ ...license, expiresAt: "2027-10-10T00:00:00.000Z" }, key.publicKey)).toBe(false)
    expect(verifyLicenseSignature({ ...license, deviceId: "VWLB-1111-2222-3333-4444" }, key.publicKey)).toBe(false)
    expect(verifyLicenseSignature({ ...license, plan: "annual" }, key.publicKey)).toBe(false)
  })

  it("verificar con OTRA clave pública → false (licencia de otro emisor)", () => {
    const issuer = generateLicenseKeyPair()
    const attacker = generateLicenseKeyPair()
    const signature = signLicense(basePayload, issuer.privateKey)
    const license = { ...basePayload, signature }
    expect(verifyLicenseSignature(license, attacker.publicKey)).toBe(false)
  })

  it("payload re-serializado con otro orden de claves → verificación OK (canónico)", () => {
    const key = generateLicenseKeyPair()
    const signature = signLicense(basePayload, key.privateKey)
    const reordered = {
      signature,
      product: "ViewLBA-Server",
      features: { "users.management": true },
      installPath: "c:/pantallarestaurante",
      diskId: "DSK-A5ED-432A-37DD",
      deviceId: "VWLB-0094-6114-A3A4-8905",
      expiresAt: "2026-10-10T00:00:00.000Z",
      startsAt: "2026-09-10T00:00:00.000Z",
      issuedAt: "2026-09-10T00:00:00.000Z",
      plan: "monthly",
      customerName: "Leandro Bueno",
      licenseId: "VLBA-aaaaaaaaaaaa",
      schemaVersion: 1,
    }
    expect(verifyLicenseSignature(reordered, key.publicKey)).toBe(true)
  })

  it("firma inválida/malformada → false sin lanzar", () => {
    const key = generateLicenseKeyPair()
    const license = { ...basePayload, signature: "AAAA-invalida-pero-larga-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    expect(verifyLicenseSignature(license, key.publicKey)).toBe(false)
    expect(verifyLicenseSignature({ ...basePayload, signature: "" }, key.publicKey)).toBe(false)
    expect(verifyLicenseSignature({ ...basePayload, signature: 12345 }, key.publicKey)).toBe(false)
  })

  it("clave malformada → lanza error claro (firmante), false (verificador)", () => {
    expect(() => signLicense(basePayload, "no-es-una-clave")).toThrow()
    const license = { ...basePayload, signature: signLicense(basePayload, generateLicenseKeyPair().privateKey) }
    expect(verifyLicenseSignature(license, "clave-publica-malformada")).toBe(false)
  })
})

describe("helpers", () => {
  it("newLicenseId: formato VLBA-XXXXXXXXXXXX", () => {
    const id = newLicenseId()
    expect(id).toMatch(/^VLBA-[0-9a-f]{12}$/)
    expect(newLicenseId()).not.toBe(id)
  })

  it("randomHex(n) → 2n chars hex", () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("sha256Hex: determinista, 64 chars", () => {
    expect(sha256Hex("viewlba")).toBe(sha256Hex("viewlba"))
    expect(sha256Hex("viewlba")).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex("viewlba")).not.toBe(sha256Hex("viewlbA"))
  })
})

describe("integración firma canónica (roundtrip completo)", () => {
  it("makeSignedLicense + verifyLicenseSignature + canonical son coherentes", () => {
    const key = generateLicenseKeyPair()
    const identity = makeIdentity()
    const license = makeSignedLicense(identity, key)
    expect(verifyLicenseSignature(license, key.publicKey)).toBe(true)

    // el canónico firmado NO incluye signature
    const { signature, ...payload } = license
    const canonical = canonicalizeLicensePayload(payload as unknown as Record<string, unknown>)
    expect(canonical).not.toContain("signature")
    expect(canonical.length).toBeGreaterThan(100)
  })
})
