/**
 * ViewLBA — Token de licencia VLBA2 (construcción + decodificación).
 *
 * CONSTRUCCIÓN (tests/e2e — en producción firma la app Android):
 *   payload → JSON canónico → firma Ed25519 (64B) → trama VT2 → base64url
 *   → grupos de 4 con guiones → "VLBA2-XXXX-XXXX-…"
 *
 * DECODIFICACIÓN (servidor, activación):
 *   normaliza → base64url → trama (magic/versión/CRC) → payloadBytes+firma.
 *   La verificación de la firma y del esquema vive en validator.ts.
 *
 * El token es un ÚNICO valor de copiar/pegar. Todo intento de truncarlo,
 * alterarlo, inyectarle bytes o usar una versión futura se rechaza con un
 * código estructural (TokenDecodeError) antes de tocar criptografía.
 */
import { canonicalize } from "./canonical"
import { base32DecodeStrict, base32Encode, buildTokenFrame, formatWithDashes, normalizeTokenInput, parseTokenFrame } from "./codec"
import { signTokenPayload } from "./crypto"
import { TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH, TOKEN_PAYLOAD_MAX_BYTES, TokenDecodeError, type LicenseTokenPayload } from "./types"

// ---------------------------------------------------------------------------
// Construcción (tests / e2e — referencia exacta del generador Android)
// ---------------------------------------------------------------------------

/**
 * Construye un token VLBA2 completo a partir del payload y la clave privada
 * Ed25519 del emisor. Firma la forma canónica del payload.
 */
export function buildLicenseToken(payload: LicenseTokenPayload, privateKeyB64url: string): string {
  const json = canonicalize(payload as unknown as Record<string, unknown>)
  const payloadBytes = new Uint8Array(Buffer.from(json, "utf8"))
  if (payloadBytes.length > TOKEN_PAYLOAD_MAX_BYTES) {
    throw new Error(`Payload del token demasiado grande (${payloadBytes.length} > ${TOKEN_PAYLOAD_MAX_BYTES} bytes)`)
  }
  const signature = signTokenPayload(payload, privateKeyB64url)
  const frame = buildTokenFrame(payloadBytes, signature)
  const body = base32Encode(frame)
  const token = formatWithDashes("VLBA2", body)
  if (token.replace(/-/g, "").length > TOKEN_MAX_LENGTH) {
    throw new Error("Token resultante demasiado largo")
  }
  return token
}

// ---------------------------------------------------------------------------
// Decodificación (servidor — activación y evaluación)
// ---------------------------------------------------------------------------

export interface DecodedToken {
  /** Payload JSON parseado (aún sin validar esquema ni firma). */
  payload: unknown
  /** Bytes EXACTOS del payload tal como viajaron (para verificar firma). */
  payloadBytes: Uint8Array
  /** Firma Ed25519 cruda (64 bytes). */
  signature: Uint8Array
  /** Forma normalizada del token (prefijo+cuerpo, sin guiones/espacios). */
  normalized: string
}

/**
 * Normaliza y decodifica la TRAMA de un token VLBA2 pegado.
 * Lanza TokenDecodeError con código estructural ante cualquier anomalía:
 * prefijo incorrecto, charset inválido, longitud fuera de límites, trama
 * corrupta, CRC incorrecto (alterado/truncado) o versión futura.
 */
export function decodeLicenseToken(token: string): DecodedToken {
  if (typeof token !== "string") throw new TokenDecodeError("bad_prefix", "El token debe ser texto")

  const trimmed = token.trim()
  if (trimmed.length === 0) throw new TokenDecodeError("too_short", "El token está vacío")

  const normalized = normalizeTokenInput(trimmed)
  if (!normalized) throw new TokenDecodeError("bad_prefix", "El token debe comenzar con VLBA2-")
  if (normalized.prefix !== "VLBA2") throw new TokenDecodeError("bad_prefix", "El token debe comenzar con VLBA2-")

  const totalLen = normalized.body.length + 5 // "VLBA2"
  if (totalLen < TOKEN_MIN_LENGTH) {
    throw new TokenDecodeError("too_short", "El token está incompleto (truncado)")
  }
  if (totalLen > TOKEN_MAX_LENGTH) {
    throw new TokenDecodeError("too_long", "El token excede la longitud permitida")
  }

  const bin = base32DecodeStrict(normalized.body)
  if (!bin) throw new TokenDecodeError("bad_charset", "El token contiene caracteres no permitidos")

  const frame = parseTokenFrame(bin)
  if (frame.payloadBytes.length > TOKEN_PAYLOAD_MAX_BYTES) {
    throw new TokenDecodeError("too_long", "El payload del token excede el tamaño permitido")
  }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(frame.payloadBytes).toString("utf8"))
  } catch {
    throw new TokenDecodeError("bad_json", "El contenido del token no es un JSON válido")
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TokenDecodeError("bad_json", "El contenido del token no tiene la estructura esperada")
  }

  return {
    payload,
    payloadBytes: frame.payloadBytes,
    signature: frame.signature,
    normalized: `${normalized.prefix}${normalized.body}`,
  }
}

/**
 * Normaliza un token pegado sin decodificar (para comparaciones
 * idempotentes de re-activación). Devuelve null si el prefijo no encaja.
 */
export function normalizeLicenseToken(token: string): string | null {
  const n = normalizeTokenInput(token.trim())
  return n && n.prefix === "VLBA2" ? `${n.prefix}${n.body}` : null
}
