/**
 * ViewLBA — Código de solicitud VLREQ2 (lado SERVIDOR: construcción).
 *
 * El cliente pulsa "Copiar código de solicitud" y el servidor:
 *   1. Recoge la identidad del equipo (installationId + diskId) — OCULTA al
 *      cliente: nunca se pide que la copie a mano ni se muestra en la UI.
 *   2. Construye el payload {v, product, customerName, installationId,
 *      diskId, nonce, requestedAt}.
 *   3. Lo serializa en forma canónica y lo SELLA (X25519 efímero → HKDF →
 *      AES-256-GCM) hacia la clave pública del emisor → solo la app Android
 *      del administrador puede abrirlo.
 *   4. Lo codifica como VLREQ2-XXXX-XXXX-… (base64url con guiones).
 *
 * La apertura (openRequestCode) existe en este módulo para tests/e2e y como
 * referencia exacta de la implementación del generador Android.
 */
import { canonicalize } from "./canonical"
import { base32DecodeStrict, base32Encode, formatWithDashes, normalizeTokenInput, parseRequestFrame, buildRequestFrame } from "./codec"
import { openSealedRequest, randomHex, sealRequestPayload, resolveRequestPublicKey, sha256Hex } from "./crypto"
import {
  REQUEST_CIPHERTEXT_MAX_BYTES,
  REQUEST_CODE_MAX_LENGTH,
  REQUEST_CODE_MIN_LENGTH,
  REQUEST_SCHEMA_VERSION,
  TokenDecodeError,
  type RequestCodePayload,
} from "./types"

/** Límite de antigüedad de un código de solicitud (re-export de types). */
export { REQUEST_CODE_MAX_AGE_DAYS } from "./types"

// ---------------------------------------------------------------------------
// Construcción (servidor)
// ---------------------------------------------------------------------------

export interface BuildRequestCodeInput {
  /** Nombre del negocio/cliente que solicita la licencia. */
  customerName: string
  /** Installation ID actual (derivada del hardware). */
  installationId: string
  /** Disk ID actual (derivada del disco de instalación). */
  diskId: string
  /** Override de tiempo (tests). */
  now?: number
  /** Clave pública X25519 del emisor (default: resuelta de env/producción). */
  requestPublicKey?: string
  /** Nonce explícito (tests). */
  nonce?: string
}

/** Longitudes permitidas del nombre del cliente en la solicitud. */
export const REQUEST_CUSTOMER_NAME_MIN = 2
export const REQUEST_CUSTOMER_NAME_MAX = 100

/**
 * Construye un código de solicitud VLREQ2 listo para copiar/pegar.
 * @throws Error si el customerName no cumple límites.
 */
export function buildRequestCode(input: BuildRequestCodeInput): string {
  const customerName = input.customerName.trim()
  if (customerName.length < REQUEST_CUSTOMER_NAME_MIN || customerName.length > REQUEST_CUSTOMER_NAME_MAX) {
    throw new Error(`El nombre del negocio debe tener entre ${REQUEST_CUSTOMER_NAME_MIN} y ${REQUEST_CUSTOMER_NAME_MAX} caracteres`)
  }

  const payload: RequestCodePayload = {
    v: REQUEST_SCHEMA_VERSION,
    product: "ViewLBA-Server",
    customerName,
    installationId: input.installationId,
    diskId: input.diskId,
    nonce: input.nonce ?? randomHex(16),
    requestedAt: input.now ?? Date.now(),
  }

  const json = canonicalize(payload as unknown as Record<string, unknown>)
  const sealed = sealRequestPayload(json, input.requestPublicKey ?? resolveRequestPublicKey())
  if (sealed.ciphertext.length > REQUEST_CIPHERTEXT_MAX_BYTES) {
    throw new Error("Payload de la solicitud demasiado grande")
  }

  const frame = buildRequestFrame(sealed.ephemeralPub, sealed.iv, sealed.ciphertext)
  const body = base32Encode(frame)
  const code = formatWithDashes("VLREQ2", body)
  if (code.replace(/-/g, "").length > REQUEST_CODE_MAX_LENGTH) {
    throw new Error("Código de solicitud demasiado largo")
  }
  return code
}

// ---------------------------------------------------------------------------
// Apertura (referencia del emisor + tests)
// ---------------------------------------------------------------------------

export interface OpenedRequest {
  payload: RequestCodePayload
  /** SHA-256 hex del código NORMALIZADO — hash anti-replay del emisor. */
  requestHash: string
}

/**
 * Abre y valida un código VLREQ2 con la clave privada X25519 del emisor.
 * Validaciones: prefijo, charset, longitud, trama, CRC, GCM (tag), JSON y
 * esquema del payload (v/producto/nonce/fechas/identificadores).
 * @throws TokenDecodeError / Error con mensaje legible.
 */
export function openRequestCode(code: string, requestPrivateKeyB64url: string, opts: { now?: number; maxAgeDays?: number } = {}): OpenedRequest {
  const now = opts.now ?? Date.now()
  const maxAgeDays = opts.maxAgeDays ?? 15

  const normalized = normalizeTokenInput(code)
  if (!normalized) throw new TokenDecodeError("bad_prefix", "El código debe comenzar con VLREQ2-")
  if (normalized.prefix !== "VLREQ2") throw new TokenDecodeError("bad_prefix", "El código debe comenzar con VLREQ2-")
  if (normalized.body.length < REQUEST_CODE_MIN_LENGTH - 6) {
    throw new TokenDecodeError("too_short", "El código de solicitud está incompleto (truncado)")
  }
  if (normalized.body.length > REQUEST_CODE_MAX_LENGTH - 6) {
    throw new TokenDecodeError("too_long", "El código de solicitud excede la longitud permitida")
  }

  const bin = base32DecodeStrict(normalized.body)
  if (!bin) throw new TokenDecodeError("bad_charset", "El código contiene caracteres no permitidos")

  const frame = parseRequestFrame(bin)

  const json = openSealedRequest({ ephemeralPub: frame.ephemeralPub, iv: frame.iv, ciphertext: frame.ciphertext }, requestPrivateKeyB64url)
  if (json == null) throw new TokenDecodeError("bad_frame", "El código de solicitud no se puede abrir (alterado o emisor incorrecto)")

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new TokenDecodeError("bad_json", "El contenido de la solicitud no es válido")
  }

  const p = parsed as Record<string, unknown>
  if (p.v !== REQUEST_SCHEMA_VERSION) throw new Error("Versión de solicitud no soportada")
  if (p.product !== "ViewLBA-Server") throw new Error("La solicitud corresponde a otro producto")
  if (typeof p.customerName !== "string" || p.customerName.trim().length < REQUEST_CUSTOMER_NAME_MIN || p.customerName.length > REQUEST_CUSTOMER_NAME_MAX) {
    throw new Error("El nombre del cliente en la solicitud no es válido")
  }
  if (typeof p.installationId !== "string" || !/^VWLB-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(p.installationId)) {
    throw new Error("La solicitud no contiene un Installation ID válido")
  }
  if (typeof p.diskId !== "string" || !/^DSK-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(p.diskId)) {
    throw new Error("La solicitud no contiene un Disk ID válido")
  }
  if (typeof p.nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(p.nonce)) {
    throw new Error("La solicitud no contiene un nonce válido")
  }
  if (typeof p.requestedAt !== "number" || !Number.isFinite(p.requestedAt)) {
    throw new Error("La solicitud no contiene fecha de generación")
  }
  const ageMs = now - p.requestedAt
  if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    throw new Error(`El código de solicitud expiró (máximo ${maxAgeDays} días de validez) — pide al cliente que genere uno nuevo`)
  }
  if (ageMs < -24 * 60 * 60 * 1000) {
    throw new Error("La solicitud tiene una fecha de generación futura (reloj incorrecto)")
  }

  return {
    payload: {
      v: p.v as number,
      product: p.product as string,
      customerName: p.customerName,
      installationId: p.installationId,
      diskId: p.diskId,
      nonce: p.nonce,
      requestedAt: p.requestedAt,
    },
    requestHash: sha256OfCode(normalized.prefix, normalized.body),
  }
}

/** Hash estable del código normalizado (prefijo + cuerpo sin guiones). */
export function sha256OfCode(prefix: string, body: string): string {
  return sha256Hex(`${prefix}${body}`)
}

/**
 * Normaliza (sin validar/aprir) un código pegado: elimina espacios/guiones
 * y devuelve prefijo+cuerpo. Útil para comparaciones idempotentes.
 */
export function normalizeRequestCode(code: string): string | null {
  const n = normalizeTokenInput(code)
  return n ? `${n.prefix}${n.body}` : null
}
