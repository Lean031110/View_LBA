/**
 * ViewLBA — Validador del token VLBA2 (núcleo de seguridad del servidor).
 *
 * ORDEN CRÍTICO de validación (idéntico al del flujo de activación):
 *   1. Decodificación estructural de la trama (prefijo/charset/longitud/
 *      magic/versión/CRC32) — ANTES de cualquier criptografía.
 *   2. VERIFICACIÓN DE FIRMA Ed25519 sobre los bytes EXACTOS del payload
 *      (sin coerción previa — modificar 1 byte rompe la firma).
 *   3. Validación semántica (zod) SOLO después de firma válida.
 *   4. Producto (ViewLBA-Server) y coherencia de fechas/duración.
 *   5. Binding: installationId + diskId contra el hardware ACTUAL.
 *   6. Vigencia con el reloj efectivo anti-rollback.
 *
 * Estados de salida: active | grace | expired | invalid | mismatch.
 * Solo "valid=true" si TODO pasa.
 */
import { z } from "zod"
import { resolveVerifierPublicKey, verifyTokenSignature } from "./crypto"
import { INSTALLATION_ID_RE } from "./fingerprint"
import { DISK_ID_RE } from "./disk-binding"
import { decodeLicenseToken } from "./token"
import {
  LICENSE_PRODUCT,
  LICENSE_SCHEMA_VERSION,
  MAX_CUSTOM_DURATION_DAYS,
  PLAN_DURATION_DAYS,
  TokenDecodeError,
  type ActivationRejectCode,
  type InstallationIdentity,
  type LicensePlan,
  type LicenseTokenPayload,
  type LicenseValidationResult,
} from "./types"

const DAY_MS = 24 * 60 * 60 * 1000

/** Ventana de gracia tras el vencimiento (horas). Default 0 = deshabilitada. */
export function licenseGraceHours(): number {
  const n = Number(process.env.LICENSE_GRACE_HOURS ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// Esquema semántico (se aplica DESPUÉS de verificar la firma)
// ---------------------------------------------------------------------------

const licenseSemanticSchema = z.object({
  v: z.literal(LICENSE_SCHEMA_VERSION),
  licenseId: z.string().regex(/^VLBA-[0-9a-fA-F]{12}$/),
  customerName: z.string().min(1).max(200),
  plan: z.enum(["monthly", "annual", "custom"]),
  durationDays: z.number().int().min(1).max(MAX_CUSTOM_DURATION_DAYS),
  product: z.literal(LICENSE_PRODUCT),
  issuedAt: z.number().int().positive(),
  startsAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  installationId: z.string().regex(INSTALLATION_ID_RE),
  diskId: z.string().regex(DISK_ID_RE),
  features: z.record(z.string().max(64), z.boolean()),
  nonce: z.string().regex(/^[0-9a-f]{16,64}$/),
})

export interface ValidateTokenOptions {
  /** Reloj efectivo (ms epoch) — ya ajustado por anti-rollback. */
  now?: number
  /** Clave pública alternativa (tests / rotación). Default: resuelta. */
  publicKey?: string
}

/** Mapea un TokenDecodeError al código de rechazo de activación. */
export function decodeErrorToRejectCode(e: TokenDecodeError): ActivationRejectCode {
  switch (e.code) {
    case "bad_prefix":
      return "bad_prefix"
    case "bad_charset":
      return "bad_charset"
    case "too_short":
      return "too_short"
    case "too_long":
      return "too_long"
    case "bad_frame":
      return "bad_frame"
    case "bad_version":
      return "bad_version"
    case "bad_crc":
      return "bad_crc"
    case "bad_json":
      return "bad_json"
  }
}

/**
 * Decodifica + verifica firma + valida esquema de un token VLBA2 pegado.
 * @throws TokenDecodeError si la TRAMA es inválida (estructural).
 * @returns resultado con payload verificado; valid=false si firma/esquema/
 *          producto/fechas fallan (motivos legibles es-ES).
 */
export function verifyLicenseToken(token: string, opts: ValidateTokenOptions = {}): LicenseValidationResult & { payloadBytes?: Uint8Array } {
  const now = opts.now ?? Date.now()
  const publicKey = opts.publicKey ?? resolveVerifierPublicKey()

  // ---------- 1. Trama estructural (lanza TokenDecodeError) ----------
  const decoded = decodeLicenseToken(token)

  // ---------- 2. FIRMA Ed25519 sobre los bytes EXACTOS ----------
  const signatureOk = verifyTokenSignature(decoded.payloadBytes, decoded.signature, publicKey)
  if (!signatureOk) {
    return { valid: false, status: "invalid", reasons: ["El token no fue emitido por ViewLBA o fue modificado"] }
  }

  // ---------- 3. Semántica (la firma ya garantó integridad) ----------
  const semantic = licenseSemanticSchema.safeParse(decoded.payload)
  if (!semantic.success) {
    return { valid: false, status: "invalid", reasons: ["El token no cumple el esquema de licencia ViewLBA (versión o campos inválidos)"] }
  }
  const data = semantic.data as LicenseTokenPayload

  // ---------- 4. Producto + coherencia de fechas/duración ----------
  if (data.startsAt >= data.expiresAt) {
    return { valid: false, status: "invalid", reasons: ["Fechas incoherentes: el inicio es posterior al vencimiento"] }
  }
  // La duración firmada debe coincidir EXACTAMENTE con las fechas firmadas
  // (el generador emite expiresAt = startsAt + durationDays·día exacto).
  if (data.expiresAt !== data.startsAt + data.durationDays * DAY_MS) {
    return { valid: false, status: "invalid", reasons: ["La duración firmada no coincide con las fechas del token"] }
  }
  // Los planes estándar deben usar su duración exacta (el "custom" la decide
  // el administrador dentro de los límites).
  if (data.plan !== "custom" && data.durationDays !== PLAN_DURATION_DAYS[data.plan as Exclude<LicensePlan, "custom">]) {
    return { valid: false, status: "invalid", reasons: ["La duración no corresponde al plan firmado"] }
  }
  // issuedAt no puede estar en el futuro (tolerancia 24h de desviación de reloj)
  if (data.issuedAt > now + DAY_MS) {
    return { valid: false, status: "invalid", reasons: ["El token tiene una fecha de emisión futura"] }
  }

  return { valid: true, status: "active", reasons: [], payload: data, payloadBytes: decoded.payloadBytes }
}

/**
 * Validación COMPLETA contra la instalación actual (binding + vigencia).
 * Se usa tanto en la activación como en la re-evaluación continua.
 */
export function validateLicenseToken(
  token: string,
  identity: InstallationIdentity,
  opts: ValidateTokenOptions = {}
): LicenseValidationResult {
  const now = opts.now ?? Date.now()
  const publicKey = opts.publicKey ?? resolveVerifierPublicKey()

  const decoded = decodeLicenseToken(token)
  const verified = verifyLicenseToken(token, { now, publicKey })
  if (!verified.valid) return verified
  const data = verified.payload!

  // ---------- 5. Binding contra el hardware ACTUAL ----------
  const deviceMatch = data.installationId.toUpperCase() === identity.installationId.toUpperCase()
  const diskMatch = data.diskId.toUpperCase() === identity.diskId.toUpperCase()
  if (!deviceMatch || !diskMatch) {
    const reasons: string[] = []
    if (!deviceMatch) reasons.push("La licencia está vinculada a otro equipo")
    if (!diskMatch) reasons.push("La licencia está vinculada a otro disco")
    return { valid: false, status: "mismatch", reasons, payload: data }
  }

  // ---------- 6. Vigencia (con reloj efectivo anti-rollback) ----------
  const graceMs = licenseGraceHours() * 60 * 60 * 1000
  if (now < data.startsAt) {
    return {
      valid: false,
      status: "invalid",
      reasons: [`La licencia aún no está vigente (comienza el ${formatDay(data.startsAt)})`],
      payload: data,
    }
  }
  if (now >= data.expiresAt) {
    const status = now < data.expiresAt + graceMs && graceMs > 0 ? "grace" : "expired"
    return {
      valid: status === "grace",
      status,
      reasons: [status === "grace" ? `Licencia vencida (en período de gracia hasta ${formatDay(data.expiresAt + graceMs)})` : "Licencia vencida"],
      payload: data,
    }
  }

  return { valid: true, status: "active", reasons: [], payload: data }
}

/** Días restantes de una licencia activa (techo 0, con reloj efectivo). */
export function licenseDaysLeft(expiresAtMs: number, now = Date.now()): number {
  const ms = expiresAtMs - now
  return Math.max(0, Math.ceil(ms / DAY_MS))
}

/** Fecha "DD/MM/YYYY" legible (para mensajes humanos). */
export function formatDay(ms: number): string {
  const d = new Date(ms)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${dd}/${mm}/${d.getUTCFullYear()}`
}
