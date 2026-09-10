/**
 * ViewLBA — Criptografía Ed25519 para licencias (node:crypto, cero deps).
 *
 * Formato de claves: base64url de los 32 bytes crudos (seed/punto público).
 * Se reconstruyen los KeyObject con los prefijos DER fijos de Ed25519:
 *   PKCS8: 302e020100300506032b657004220420 || seed(32)
 *   SPKI : 302a300506032b6570032100          || pub(32)
 *
 * ⚠ REGLA DE SEGURIDAD: la clave PRIVADA solo se pasa COMO ARGUMENTO desde
 *   el generador de licencias (tools/license-generator) o los tests. Este
 *   módulo NUNCA la lee del entorno por su cuenta y JAMÁS se incluye una
 *   clave privada en el producto (ver docs/LICENSE-SECURITY.md).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto"
import { canonicalizeLicensePayload, stripSignature } from "./canonical"
import type { LicensePayload, SignedLicense } from "./types"
import { PRODUCTION_LICENSE_PUBLIC_KEY } from "./public-key"

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

const KEY_B64URL_RE = /^[A-Za-z0-9_-]{43}$/

// ---------------------------------------------------------------------------
// KeyObject helpers
// ---------------------------------------------------------------------------

/** ¿Parece una clave Ed25519 cruda válida (base64url, 32 bytes)? */
export function isValidRawKey(key: string): boolean {
  return KEY_B64URL_RE.test(key)
}

function privateKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave privada Ed25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
}

function publicKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave pública Ed25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPublicKey({ key: der, format: "der", type: "spki" })
}

// ---------------------------------------------------------------------------
// Generación de pares (solo generador de licencias / tests)
// ---------------------------------------------------------------------------

export interface LicenseKeyPair {
  /** base64url, 32 bytes — puede publicarse (verificador). */
  publicKey: string
  /** base64url, 32 bytes — SECRETO: nunca commitear ni enviar al cliente. */
  privateKey: string
}

/** Genera un par de claves Ed25519 en formato crudo base64url. */
export function generateLicenseKeyPair(): LicenseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  return {
    publicKey: spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url"),
    privateKey: pkcs8.subarray(ED25519_PKCS8_PREFIX.length).toString("base64url"),
  }
}

// ---------------------------------------------------------------------------
// Firma y verificación
// ---------------------------------------------------------------------------

/**
 * Firma el payload canónico con la clave privada Ed25519 indicada.
 * (Usada SOLO por el generador de licencias y los tests.)
 * @returns firma en base64url (64 bytes)
 */
export function signLicense(payload: LicensePayload, privateKeyB64url: string): string {
  const canonical = canonicalizeLicensePayload(payload as unknown as Record<string, unknown>)
  return sign(null, Buffer.from(canonical, "utf8"), privateKeyObject(privateKeyB64url)).toString("base64url")
}

/**
 * Verifica la firma de una licencia (SignedLicense) contra una clave pública.
 * La firma cubre TODO el payload excepto "signature" (forma canónica).
 */
export function verifyLicenseSignature(license: SignedLicense, publicKeyB64url: string): boolean {
  try {
    const canonical = canonicalizeLicensePayload(stripSignature(license as unknown as Record<string, unknown>))
    const sig = Buffer.from(license.signature, "base64url")
    if (sig.length !== 64) return false
    return verify(null, Buffer.from(canonical, "utf8"), publicKeyObject(publicKeyB64url), sig)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Resolución de la clave pública del verificador (app)
// ---------------------------------------------------------------------------

/**
 * Clave pública usada por la app para verificar:
 *  1. VIEWLBA_LICENSE_PUBLIC_KEY (env; para tests/E2E o rotación)
 *  2. Clave pública de producción incrustada (public-key.ts)
 * NUNCA una clave privada.
 */
export function resolveVerifierPublicKey(): string {
  const fromEnv = process.env.VIEWLBA_LICENSE_PUBLIC_KEY?.trim()
  if (fromEnv && isValidRawKey(fromEnv)) return fromEnv
  return PRODUCTION_LICENSE_PUBLIC_KEY
}

// ---------------------------------------------------------------------------
// Utilidades compartidas con el generador
// ---------------------------------------------------------------------------

/** SHA-256 hex de un string (helper de fingerprints y bindings). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** Genera un licenseId con formato VLBA-XXXXXXXXXXXX (12 hex aleatorios). */
export function newLicenseId(): string {
  return `VLBA-${randomHex(6)}`
}

/** Genera bytes aleatorios hex (para licenseId del generador). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}
