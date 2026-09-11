/**
 * ViewLBA — Criptografía del sistema de licencias v2 (node:crypto, cero deps).
 *
 * PRIMITIVAS:
 *  · Ed25519        — firma/verificación de tokens VLBA2.
 *  · X25519 (ECDH)  — sellado/apertura de códigos de solicitud VLREQ2.
 *  · HKDF-SHA256    — derivación de la clave simétrica del sellado.
 *  · AES-256-GCM    — cifrado autenticado del payload de la solicitud.
 *
 * Formato de claves: base64url de los 32 bytes crudos (seed/punto público).
 * Los KeyObject se reconstruyen con prefijos DER fijos:
 *   Ed25519 PKCS8: 302e020100300506032b657004220420 || seed(32)
 *   Ed25519 SPKI : 302a300506032b6570032100          || pub(32)
 *   X25519  PKCS8: 302e020100300506032b656e04220420 || priv(32)
 *   X25519  SPKI : 302a300506032b656e032100          || pub(32)
 *
 * ⚠ REGLA DE SEGURIDAD: las claves PRIVADAS solo se pasan COMO ARGUMENTO
 *   desde tests (y, en producción, viven SOLO en la app Android del emisor).
 *   Este módulo NUNCA las lee del entorno por su cuenta y JAMÁS se incluye
 *   una clave privada en el producto (ver docs/LICENSE-SECURITY.md).
 */
import { createHash, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto"
import { canonicalize } from "./canonical"
import type { LicenseTokenPayload } from "./types"
import { PRODUCTION_LICENSE_PUBLIC_KEY, PRODUCTION_REQUEST_PUBLIC_KEY } from "./public-key"

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex")
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex")

const KEY_B64URL_RE = /^[A-Za-z0-9_-]{43}$/

// ---------------------------------------------------------------------------
// KeyObject helpers (claves crudas base64url ↔ KeyObject)
// ---------------------------------------------------------------------------

/** ¿Parece una clave cruda válida (base64url, 32 bytes)? */
export function isValidRawKey(key: string): boolean {
  return KEY_B64URL_RE.test(key)
}

function edPrivateKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave privada Ed25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
}

function edPublicKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave pública Ed25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPublicKey({ key: der, format: "der", type: "spki" })
}

function xPrivateKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave privada X25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
}

function xPublicKeyObject(rawB64url: string) {
  if (!isValidRawKey(rawB64url)) throw new Error("Clave pública X25519 mal formada (se esperaban 32 bytes en base64url)")
  const der = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(rawB64url, "base64url")])
  return createPublicKey({ key: der, format: "der", type: "spki" })
}

/** KeyObject pública X25519 desde los 32 bytes crudos (punto efímero). */
function xPublicKeyObjectFromRaw(raw: Uint8Array) {
  if (raw.length !== 32) throw new Error("Punto público X25519 inválido (se esperaban 32 bytes)")
  const der = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)])
  return createPublicKey({ key: der, format: "der", type: "spki" })
}

// ---------------------------------------------------------------------------
// Generación de pares (solo generador Android / tests)
// ---------------------------------------------------------------------------

export interface LicenseKeyPair {
  publicKey: string
  privateKey: string
}

/** Genera un par de claves Ed25519 (firma de tokens) en crudo base64url. */
export function generateLicenseKeyPair(): LicenseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  return {
    publicKey: spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url"),
    privateKey: pkcs8.subarray(ED25519_PKCS8_PREFIX.length).toString("base64url"),
  }
}

/** Genera un par de claves X25519 (apertura de solicitudes) en crudo base64url. */
export function generateRequestKeyPair(): LicenseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519" as never)
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  return {
    publicKey: spki.subarray(X25519_SPKI_PREFIX.length).toString("base64url"),
    privateKey: pkcs8.subarray(X25519_PKCS8_PREFIX.length).toString("base64url"),
  }
}

// ---------------------------------------------------------------------------
// Firma y verificación Ed25519 (tokens VLBA2)
// ---------------------------------------------------------------------------

/**
 * Serializa el payload en forma canónica y lo firma con Ed25519.
 * (Usada SOLO por tests/e2e; en producción firma la app Android.)
 * @returns firma cruda (64 bytes)
 */
export function signTokenPayload(payload: LicenseTokenPayload, privateKeyB64url: string): Uint8Array {
  const canonical = canonicalize(payload as unknown as Record<string, unknown>)
  return new Uint8Array(sign(null, Buffer.from(canonical, "utf8"), edPrivateKeyObject(privateKeyB64url)))
}

/** Verifica la firma Ed25519 sobre los bytes EXACTOS del payload del token. */
export function verifyTokenSignature(payloadBytes: Uint8Array, signature: Uint8Array, publicKeyB64url: string): boolean {
  if (signature.length !== 64) return false
  try {
    return verify(null, Buffer.from(payloadBytes), edPublicKeyObject(publicKeyB64url), Buffer.from(signature))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Sellado de solicitudes (X25519 efímero → HKDF → AES-256-GCM)
// ---------------------------------------------------------------------------

const REQUEST_HKDF_INFO = Buffer.from("viewlba-req-v2", "utf8")

/** Deriva la clave de sellado: HKDF-SHA256(shared, salt=ephPub, info). */
function deriveSealKey(shared: Buffer, ephemeralPub: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(ephemeralPub), REQUEST_HKDF_INFO, 32))
}

export interface SealedRequest {
  ephemeralPub: Uint8Array
  iv: Uint8Array
  ciphertext: Uint8Array
}

/**
 * Sella el payload JSON de una solicitud hacia la clave pública X25519 del
 * emisor (sealed box). Solo el emisor (con la privada X25519) puede abrirlo.
 */
export function sealRequestPayload(payloadJson: string, requestPublicKeyB64url: string): SealedRequest {
  const eph = generateKeyPairSync("x25519" as never)
  const ephPubDer = eph.publicKey.export({ format: "der", type: "spki" }) as Buffer
  const ephPub = new Uint8Array(ephPubDer.subarray(X25519_SPKI_PREFIX.length))
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: xPublicKeyObject(requestPublicKeyB64url) })
  const key = deriveSealKey(shared, ephPub)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(payloadJson, "utf8")), cipher.final(), cipher.getAuthTag()])
  return { ephemeralPub: ephPub, iv: new Uint8Array(iv), ciphertext: new Uint8Array(ct) }
}

/**
 * Abre un sealed box de solicitud con la clave PRIVADA X25519 del emisor.
 * ECDH: shared = requestPriv × ephPub (simétrico al sellado ephPriv × requestPub).
 * @returns el payload JSON en claro (string) o null si el tag GCM no verifica.
 */
export function openSealedRequest(sealed: SealedRequest, requestPrivateKeyB64url: string): string | null {
  try {
    const priv = xPrivateKeyObject(requestPrivateKeyB64url)
    const shared = diffieHellman({ privateKey: priv, publicKey: xPublicKeyObjectFromRaw(sealed.ephemeralPub) })
    const key = deriveSealKey(shared, sealed.ephemeralPub)
    const ct = Buffer.from(sealed.ciphertext)
    if (ct.length < 16) return null
    const tag = ct.subarray(ct.length - 16)
    const body = ct.subarray(0, ct.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv))
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(body), decipher.final()])
    return pt.toString("utf8")
  } catch {
    return null // tag GCM inválido (manipulado) o trama corrupta
  }
}

// ---------------------------------------------------------------------------
// Resolución de las claves públicas del verificador (app servidor)
// ---------------------------------------------------------------------------

/**
 * Clave pública Ed25519 usada por el servidor para verificar tokens:
 *  1. VIEWLBA_LICENSE_PUBLIC_KEY (env; para tests/E2E o rotación)
 *  2. Clave pública de producción incrustada (public-key.ts)
 * NUNCA una clave privada.
 */
export function resolveVerifierPublicKey(): string {
  const fromEnv = process.env.VIEWLBA_LICENSE_PUBLIC_KEY?.trim()
  if (fromEnv && isValidRawKey(fromEnv)) return fromEnv
  return PRODUCTION_LICENSE_PUBLIC_KEY
}

/**
 * Clave pública X25519 usada por el servidor para SELLAR códigos de
 * solicitud: 1. VIEWLBA_REQUEST_PUBLIC_KEY (env) 2. la incrustada.
 */
export function resolveRequestPublicKey(): string {
  const fromEnv = process.env.VIEWLBA_REQUEST_PUBLIC_KEY?.trim()
  if (fromEnv && isValidRawKey(fromEnv)) return fromEnv
  return PRODUCTION_REQUEST_PUBLIC_KEY
}

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------

/** SHA-256 hex de un string (helper de fingerprints y bindings). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** SHA-256 hex de bytes (hash de códigos/tokens para anti-replay). */
export function sha256HexOfBytes(input: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(input)).digest("hex")
}

/** Genera un licenseId con formato VLBA-XXXXXXXXXXXX (12 hex aleatorios). */
export function newLicenseId(): string {
  return `VLBA-${randomBytes(6).toString("hex")}`
}

/** Genera un nonce hexadecimal de N bytes aleatorios. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}
