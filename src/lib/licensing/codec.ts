/**
 * ViewLBA — Códec de tokens VLBA2 y códigos VLREQ2.
 *
 * FORMATO EXTERNO (copiar/pegar amigable, tolerante a WhatsApp):
 *   VLBA2-A2CD-EF3H-…    VLREQ2-B4DE-…
 *  · Codificación: Base32 (RFC 4648, SIN padding) — el alfabeto A-Z/2-7 NO
 *    contiene guiones → los separadores "-" son inequívocos (a diferencia de
 *    base64url, donde "-" es un carácter de datos y rompería la decodificación).
 *  · Entrada case-insensitive: se normaliza a MAYÚSCULAS (el alfabeto base32
 *    no tiene ambigüedad de caso).
 *  · Sin espacios obligatorios: la normalización elimina guiones, espacios,
 *    saltos de línea, tabuladores y caracteres de ancho cero.
 *  · Prefijo obligatorio (VLBA2 / VLREQ2), insensible a mayúsculas.
 *
 * FORMATO DE TRAMA (bytes, antes de base32):
 *
 *  TOKEN VLBA2:
 *    [0..3)   "VT2" (magic)
 *    [3]      version = 0x02
 *    [4..6)   payloadLen (uint16 big-endian)
 *    [6..6+L) payload JSON (bytes EXACTOS firmados por Ed25519)
 *    [+64]    firma Ed25519 (64 bytes)
 *    [+4]     CRC32 IEEE de TODO lo anterior
 *
 *  CÓDIGO VLREQ2 (sealed box):
 *    [0..3)   "VR2" (magic)
 *    [3]      version = 0x02
 *    [4..36)  clave pública X25519 efímera (32 bytes)
 *    [36..48) IV AES-GCM (12 bytes)
 *    [48..50) ciphertextLen (uint16 big-endian; incluye tag GCM de 16)
 *    [50..+C) ciphertext+tag
 *    [+4]     CRC32 IEEE de TODO lo anterior
 *
 * El CRC32 da rechazo rápido de tokens truncados/alterados ANTES de intentar
 * ninguna operación criptográfica; la seguridad real vive en Ed25519/AES-GCM.
 */
import { TokenDecodeError } from "./types"

// ---------------------------------------------------------------------------
// CRC32 (IEEE, mismo polinomio del formato ZIP — implementación independiente)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 IEEE de un buffer (uint32). */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, sin padding) — alfabeto sin guiones ni +,/
// ---------------------------------------------------------------------------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const B32_RE = /^[A-Z2-7]+$/

/** Codifica a Base32 (RFC 4648) SIN padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ""
  let bits = 0
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Decodifica Base32 ESTRICTO (ya en mayúsculas, sin padding, sin guiones).
 * Devuelve null si hay cualquier carácter inválido o longitud imposible.
 */
export function base32DecodeStrict(s: string): Uint8Array | null {
  if (s.length === 0 || !B32_RE.test(s)) return null
  // Longitudes válidas mod 8: 0,2,4,5,7 (grupos completos de 5 bits → bytes)
  const rem = s.length % 8
  if (rem === 1 || rem === 3 || rem === 6) return null

  let bits = 0
  let value = 0
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    value = (value << 5) | B32_ALPHABET.indexOf(s[i])
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  // Los bits sobrantes deben ser CERO en una codificación bien formada
  // (el encoder rellena con ceros): basura al final = truncado/alterado.
  if (bits > 0 && (value & (1 << bits) - 1) !== 0) return null
  return new Uint8Array(out)
}

// ---------------------------------------------------------------------------
// Formato externo con guiones (XXXX-XXXX-…)
// ---------------------------------------------------------------------------

/** Agrupa el cuerpo base32 en bloques de 4 con guiones: "VLBA2-A2CD-…". */
export function formatWithDashes(prefix: "VLBA2" | "VLREQ2", bodyB32: string): string {
  const groups: string[] = []
  for (let i = 0; i < bodyB32.length; i += 4) groups.push(bodyB32.slice(i, i + 4))
  return `${prefix}-${groups.join("-")}`
}

/**
 * Normaliza una entrada pegada por un humano:
 *  · elimina TODOS los espacios, tabuladores, saltos de línea y guiones
 *    (incluidos guiones tipográficos y caracteres de ancho cero)
 *  · convierte a MAYÚSCULAS (el alfabeto base32 no tiene ambigüedad de caso)
 *  · exige prefijo VLBA2/VLREQ2 (case-insensitive) + cuerpo no vacío
 * Devuelve { prefix, body } o null si la estructura es irreconocible.
 */
export function normalizeTokenInput(input: string): { prefix: string; body: string } | null {
  if (typeof input !== "string") return null
  const cleaned = input
    .replace(/[\s\u00a0\u200b\ufeff]/g, "")
    .replace(/[-\u2010-\u2015\u2212\u2213]/g, "")
    .toUpperCase()
  const m = /^(VLBA2|VLREQ2)(.+)$/.exec(cleaned)
  if (!m) return null
  return { prefix: m[1], body: m[2] }
}

// ---------------------------------------------------------------------------
// Tramas binarias
// ---------------------------------------------------------------------------

const TOKEN_MAGIC = [0x56, 0x54, 0x32] // "VT2"
const REQUEST_MAGIC = [0x56, 0x52, 0x32] // "VR2"
const FRAME_VERSION = 0x02

/** Construye la trama del token VLBA2 (payload + firma + CRC32). */
export function buildTokenFrame(payloadBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  if (payloadBytes.length > 0xffff) throw new Error("Payload del token demasiado grande (máx 65535 bytes)")
  if (signature.length !== 64) throw new Error("La firma Ed25519 debe ser de 64 bytes")
  const head = Buffer.alloc(6)
  head.set(TOKEN_MAGIC, 0)
  head[3] = FRAME_VERSION
  head.writeUInt16BE(payloadBytes.length, 4)
  const body = Buffer.concat([head, Buffer.from(payloadBytes), Buffer.from(signature)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return new Uint8Array(Buffer.concat([body, crc]))
}

export interface TokenFrame {
  payloadBytes: Uint8Array
  signature: Uint8Array
}

/**
 * Decodifica la trama del token VLBA2 con validación ESTRUCTURAL estricta.
 * Lanza TokenDecodeError (bad_frame/bad_version/bad_crc) si algo no encaja.
 */
export function parseTokenFrame(bin: Uint8Array): TokenFrame {
  if (bin.length < 6 + 1 + 64 + 4) throw new TokenDecodeError("bad_frame", "Trama del token incompleta")
  if (bin[0] !== TOKEN_MAGIC[0] || bin[1] !== TOKEN_MAGIC[1] || bin[2] !== TOKEN_MAGIC[2]) {
    throw new TokenDecodeError("bad_frame", "La trama no corresponde a un token ViewLBA")
  }
  if (bin[3] !== FRAME_VERSION) {
    // versión futura o desconocida → rechazo explícito
    throw new TokenDecodeError(
      "bad_version",
      bin[3] > FRAME_VERSION ? "El token pertenece a una versión futura no soportada" : "Versión de token no soportada"
    )
  }
  const view = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength)
  const payloadLen = view.readUInt16BE(4)
  if (payloadLen === 0) throw new TokenDecodeError("bad_frame", "Token sin payload")
  const expectedLen = 6 + payloadLen + 64 + 4
  if (bin.length !== expectedLen) throw new TokenDecodeError("bad_frame", "Longitud del token inconsistente (truncado o alterado)")
  const payloadBytes = new Uint8Array(bin.subarray(6, 6 + payloadLen))
  const signature = new Uint8Array(bin.subarray(6 + payloadLen, 6 + payloadLen + 64))
  const crcStart = 6 + payloadLen + 64
  const expected = view.readUInt32BE(crcStart)
  if (crc32(bin.subarray(0, crcStart)) !== expected) {
    throw new TokenDecodeError("bad_crc", "El token está alterado o truncado (checksum incorrecto)")
  }
  return { payloadBytes, signature }
}

/** Construye la trama del código VLREQ2 (sealed box). */
export function buildRequestFrame(ephemeralPub: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ephemeralPub.length !== 32) throw new Error("Clave pública efímera X25519 inválida")
  if (iv.length !== 12) throw new Error("IV AES-GCM inválido")
  if (ciphertext.length > 0xffff) throw new Error("Ciphertext demasiado grande")
  const head = Buffer.alloc(50)
  head.set(REQUEST_MAGIC, 0)
  head[3] = FRAME_VERSION
  head.set(ephemeralPub, 4)
  head.set(iv, 36)
  head.writeUInt16BE(ciphertext.length, 48)
  const body = Buffer.concat([head, Buffer.from(ciphertext)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return new Uint8Array(Buffer.concat([body, crc]))
}

export interface RequestFrame {
  ephemeralPub: Uint8Array
  iv: Uint8Array
  ciphertext: Uint8Array
}

/**
 * Decodifica la trama del código VLREQ2 con validación estructural estricta.
 * Lanza TokenDecodeError si la estructura/CRC no encajan.
 */
export function parseRequestFrame(bin: Uint8Array): RequestFrame {
  if (bin.length < 50 + 16 + 4) throw new TokenDecodeError("bad_frame", "Trama del código de solicitud incompleta")
  if (bin[0] !== REQUEST_MAGIC[0] || bin[1] !== REQUEST_MAGIC[1] || bin[2] !== REQUEST_MAGIC[2]) {
    throw new TokenDecodeError("bad_frame", "La trama no corresponde a un código de solicitud ViewLBA")
  }
  if (bin[3] !== FRAME_VERSION) {
    throw new TokenDecodeError(
      "bad_version",
      bin[3] > FRAME_VERSION ? "El código pertenece a una versión futura no soportada" : "Versión de código no soportada"
    )
  }
  const view = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength)
  const ctLen = view.readUInt16BE(48)
  if (ctLen < 16) throw new TokenDecodeError("bad_frame", "Ciphertext del código inválido")
  const expectedLen = 50 + ctLen + 4
  if (bin.length !== expectedLen) throw new TokenDecodeError("bad_frame", "Longitud del código inconsistente (truncado o alterado)")
  const crcStart = 50 + ctLen
  if (crc32(bin.subarray(0, crcStart)) !== view.readUInt32BE(crcStart)) {
    throw new TokenDecodeError("bad_crc", "El código de solicitud está alterado o truncado")
  }
  return {
    ephemeralPub: new Uint8Array(bin.subarray(4, 36)),
    iv: new Uint8Array(bin.subarray(36, 48)),
    ciphertext: new Uint8Array(bin.subarray(50, 50 + ctLen)),
  }
}
