/**
 * Tests: criptografía del sistema v2 (Ed25519 firma + X25519 sellado).
 * Claves efímeras generadas EN RUNTIME — nunca claves reales en el repo.
 */
import { describe, expect, it } from "bun:test"
import {
  generateLicenseKeyPair,
  generateRequestKeyPair,
  signTokenPayload,
  verifyTokenSignature,
  sealRequestPayload,
  openSealedRequest,
  isValidRawKey,
  newLicenseId,
  randomHex,
  sha256Hex,
} from "@/lib/licensing/crypto"
import { canonicalize } from "@/lib/licensing/canonical"
import { makeTokenPayload, makeIdentity } from "./helpers"
import type { LicenseTokenPayload } from "@/lib/licensing/types"

const basePayload: LicenseTokenPayload = {
  v: 2,
  licenseId: "VLBA-aaaaaaaaaaaa",
  customerName: "Lo D'Leo",
  plan: "monthly",
  durationDays: 30,
  product: "ViewLBA-Server",
  issuedAt: 1757068800000,
  startsAt: 1757068800000,
  expiresAt: 1759660800000,
  installationId: "VWLB-0094-6114-A3A4-8905",
  diskId: "DSK-A5ED-432A-37DD",
  features: { "users.management": true },
  nonce: "0123456789abcdef",
}

describe("generateLicenseKeyPair (Ed25519)", () => {
  it("produce claves crudas válidas (base64url, 32 bytes)", () => {
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

describe("generateRequestKeyPair (X25519)", () => {
  it("produce claves crudas válidas (base64url, 32 bytes)", () => {
    const { publicKey, privateKey } = generateRequestKeyPair()
    expect(isValidRawKey(publicKey)).toBe(true)
    expect(isValidRawKey(privateKey)).toBe(true)
  })
})

describe("signTokenPayload / verifyTokenSignature (Ed25519)", () => {
  it("ida y vuelta: firma sobre bytes canónicos y verificación OK", () => {
    const key = generateLicenseKeyPair()
    const signature = signTokenPayload(basePayload, key.privateKey)
    expect(signature.length).toBe(64)
    const payloadBytes = new TextEncoder().encode(canonicalize(basePayload as unknown as Record<string, unknown>))
    expect(verifyTokenSignature(payloadBytes, signature, key.publicKey)).toBe(true)
  })

  it("la firma cubre TODO el payload: cambiar 1 campo rompe la verificación", () => {
    const key = generateLicenseKeyPair()
    const signature = signTokenPayload(basePayload, key.privateKey)
    const canonical = (p: LicenseTokenPayload) => new TextEncoder().encode(canonicalize(p as unknown as Record<string, unknown>))
    expect(verifyTokenSignature(canonical({ ...basePayload, customerName: "Otra Persona" }), signature, key.publicKey)).toBe(false)
    expect(verifyTokenSignature(canonical({ ...basePayload, expiresAt: basePayload.expiresAt + 1 }), signature, key.publicKey)).toBe(false)
    expect(verifyTokenSignature(canonical({ ...basePayload, installationId: "VWLB-1111-2222-3333-4444" }), signature, key.publicKey)).toBe(false)
    expect(verifyTokenSignature(canonical({ ...basePayload, plan: "annual", durationDays: 365 }), signature, key.publicKey)).toBe(false)
  })

  it("verificar con OTRA clave pública → false (licencia de otro emisor)", () => {
    const issuer = generateLicenseKeyPair()
    const attacker = generateLicenseKeyPair()
    const signature = signTokenPayload(basePayload, issuer.privateKey)
    const payloadBytes = new TextEncoder().encode(canonicalize(basePayload as unknown as Record<string, unknown>))
    expect(verifyTokenSignature(payloadBytes, signature, attacker.publicKey)).toBe(false)
  })

  it("firma de longitud incorrecta → false sin lanzar", () => {
    const key = generateLicenseKeyPair()
    const payloadBytes = new TextEncoder().encode(canonicalize(basePayload as unknown as Record<string, unknown>))
    expect(verifyTokenSignature(payloadBytes, new Uint8Array(32), key.publicKey)).toBe(false)
    expect(verifyTokenSignature(payloadBytes, new Uint8Array(64), key.publicKey)).toBe(false)
  })

  it("clave malformada → lanza error claro (firmante), false (verificador)", () => {
    expect(() => signTokenPayload(basePayload, "no-es-una-clave")).toThrow()
    const payloadBytes = new TextEncoder().encode("x")
    expect(verifyTokenSignature(payloadBytes, new Uint8Array(64), "clave-publica-malformada")).toBe(false)
  })

  it("integración: makeTokenPayload + firma + verificación canónica coherentes", () => {
    const key = generateLicenseKeyPair()
    const identity = makeIdentity()
    const payload = makeTokenPayload(identity, { plan: "annual", durationDays: 365 })
    const signature = signTokenPayload(payload, key.privateKey)
    const payloadBytes = new TextEncoder().encode(canonicalize(payload as unknown as Record<string, unknown>))
    expect(verifyTokenSignature(payloadBytes, signature, key.publicKey)).toBe(true)
  })
})

describe("sealRequestPayload / openSealedRequest (X25519 + HKDF + AES-256-GCM)", () => {
  it("ida y vuelta: sellar hacia la pública y abrir con la privada", () => {
    const pair = generateRequestKeyPair()
    const json = '{"customerName":"Lo D\'Leo","v":2}'
    const sealed = sealRequestPayload(json, pair.publicKey)
    expect(sealed.ephemeralPub.length).toBe(32)
    expect(sealed.iv.length).toBe(12)
    expect(sealed.ciphertext.length).toBeGreaterThan(16)
    expect(openSealedRequest(sealed, pair.privateKey)).toBe(json)
  })

  it("cada sellado usa una clave efímera DISTINTA (ciphertexts distintos)", () => {
    const pair = generateRequestKeyPair()
    const json = '{"a":1}'
    const a = sealRequestPayload(json, pair.publicKey)
    const b = sealRequestPayload(json, pair.publicKey)
    expect(Buffer.compare(Buffer.from(a.ephemeralPub), Buffer.from(b.ephemeralPub))).not.toBe(0)
    expect(Buffer.compare(Buffer.from(a.ciphertext), Buffer.from(b.ciphertext))).not.toBe(0)
    // ambos abren bien
    expect(openSealedRequest(a, pair.privateKey)).toBe(json)
    expect(openSealedRequest(b, pair.privateKey)).toBe(json)
  })

  it("manipular el ciphertext → tag GCM inválido → null", () => {
    const pair = generateRequestKeyPair()
    const sealed = sealRequestPayload('{"x":1}', pair.publicKey)
    const tampered = new Uint8Array(sealed.ciphertext)
    tampered[0] ^= 0x01
    expect(openSealedRequest({ ...sealed, ciphertext: tampered }, pair.privateKey)).toBeNull()
  })

  it("manipular el IV → null", () => {
    const pair = generateRequestKeyPair()
    const sealed = sealRequestPayload('{"x":1}', pair.publicKey)
    const badIv = new Uint8Array(sealed.iv)
    badIv[0] ^= 0x01
    expect(openSealedRequest({ ...sealed, iv: badIv }, pair.privateKey)).toBeNull()
  })

  it("abrir con la clave privada de OTRO par → null (solo el emisor lee)", () => {
    const right = generateRequestKeyPair()
    const wrong = generateRequestKeyPair()
    const sealed = sealRequestPayload('{"secreto":"nombre"}', right.publicKey)
    expect(openSealedRequest(sealed, wrong.privateKey)).toBeNull()
  })

  it("clave malformada → null (verificador) / throw (sellado)", () => {
    const pair = generateRequestKeyPair()
    const sealed = sealRequestPayload('{"x":1}', pair.publicKey)
    expect(openSealedRequest(sealed, "clave-malformada")).toBeNull()
    expect(() => sealRequestPayload('{"x":1}', "clave-malformada")).toThrow()
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
