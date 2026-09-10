/**
 * ViewLBA — Validador de licencias (núcleo de seguridad del producto).
 *
 * ORDEN CRÍTICO de validación:
 *   1. Parse JSON estructural mínimo (objeto con "signature").
 *   2. VERIFICACIÓN DE FIRMA Ed25519 sobre la forma canónica del payload
 *      EXACTO tal como vino (sin coerción previa — cualquier modificación
 *      de 1 byte rompe la firma).
 *   3. Validación semántica (zod) SOLO después de firma válida.
 *   4. Fechas (start <= now < expiry, con gracia opcional).
 *   5. Binding: deviceId (Installation ID) + diskId vs hardware ACTUAL.
 *   6. installPath: SOLO advertencia (binding opcional, no estricto).
 *
 * Estados de salida: active | grace | expired | invalid | mismatch.
 * Solo "valid=true" si TODO pasa (sección 15: "Solo guardar si TODO pasa").
 */
import { z } from "zod"
import { verifyLicenseSignature, resolveVerifierPublicKey } from "./crypto"
import { normalizeInstallPath, DISK_ID_RE } from "./disk-binding"
import { INSTALLATION_ID_RE } from "./fingerprint"
import { LICENSE_PRODUCT, LICENSE_SCHEMA_VERSION, type InstallationIdentity, type LicenseValidationResult } from "./types"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Ventana de gracia tras el vencimiento (horas). Default 0 = deshabilitada. */
export function licenseGraceHours(): number {
  const n = Number(process.env.LICENSE_GRACE_HOURS ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// Esquema semántico (se aplica DESPUÉS de verificar la firma)
// ---------------------------------------------------------------------------

const licenseSemanticSchema = z.object({
  schemaVersion: z.literal(LICENSE_SCHEMA_VERSION),
  licenseId: z.string().regex(/^VLBA-[0-9a-fA-F]{12}$/),
  customerName: z.string().min(1).max(200),
  plan: z.enum(["monthly", "annual"]),
  issuedAt: z.string().regex(ISO_DATE_RE),
  startsAt: z.string().regex(ISO_DATE_RE),
  expiresAt: z.string().regex(ISO_DATE_RE),
  deviceId: z.string().regex(INSTALLATION_ID_RE),
  diskId: z.string().regex(DISK_ID_RE),
  installPath: z.string().min(1).max(500),
  product: z.literal(LICENSE_PRODUCT),
  features: z.record(z.string(), z.boolean()),
  signature: z.string().min(80),
})

export interface ValidateLicenseOptions {
  /** Reloj efectivo (ms epoch) — ya ajustado por anti-rollback. */
  now?: number
  /** Clave pública alternativa (tests / rotación). Default: resuelta. */
  publicKey?: string
}

/** ¿El JSON parece una licencia firmada (estructura mínima pre-firma)? */
function looksLikeSignedLicense(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj) && "signature" in obj && "deviceId" in obj && "expiresAt" in obj
}

/**
 * Valida una licencia (objeto parsed de license.json) contra la identidad
 * de la instalación ACTUAL. Función PURA (sin I/O de red — 100% offline).
 */
export function validateLicense(licenseJson: unknown, identity: InstallationIdentity, opts: ValidateLicenseOptions = {}): LicenseValidationResult {
  const now = opts.now ?? Date.now()
  const publicKey = opts.publicKey ?? resolveVerifierPublicKey()
  const reasons: string[] = []

  // ---------- 1. Estructura mínima ----------
  if (!looksLikeSignedLicense(licenseJson)) {
    return { valid: false, status: "invalid", reasons: ["El archivo no tiene la estructura de una licencia ViewLBA"] }
  }

  const license = licenseJson as Record<string, unknown>

  // ---------- 2. FIRMA sobre el payload EXACTO (sin coerción) ----------
  let signatureOk = false
  try {
    signatureOk = verifyLicenseSignature(license as never, publicKey)
  } catch {
    signatureOk = false
  }
  if (!signatureOk) {
    return {
      valid: false,
      status: "invalid",
      reasons: ["Firma digital inválida: la licencia fue modificada o no fue emitida por ViewLBA"],
    }
  }

  // ---------- 3. Semántica (la firma ya garantó integridad) ----------
  const semantic = licenseSemanticSchema.safeParse(license)
  if (!semantic.success) {
    const first = semantic.error.issues[0]
    const field = first?.path?.join(".") ?? "(raíz)"
    return {
      valid: false,
      status: "invalid",
      reasons: [`Campo inválido: ${field} — ${first?.message ?? "esquema de licencia incorrecto"}`],
    }
  }
  const data = semantic.data

  // ---------- 4. Coherencia de fechas ----------
  const issuedAt = Date.parse(data.issuedAt)
  const startsAt = Date.parse(data.startsAt)
  const expiresAt = Date.parse(data.expiresAt)
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) {
    return { valid: false, status: "invalid", reasons: ["Fechas de licencia ilegibles"] }
  }
  if (startsAt >= expiresAt) {
    return { valid: false, status: "invalid", reasons: ["Fechas incoherentes: el inicio es posterior al vencimiento"] }
  }

  // ---------- 5. Binding contra el hardware ACTUAL ----------
  const detail: LicenseValidationResult["detail"] = {
    expectedInstallationId: identity.installationId,
    foundInstallationId: data.deviceId,
    expectedDiskId: identity.diskId,
    foundDiskId: data.diskId,
  }
  const licenseMeta = {
    licenseId: data.licenseId,
    customerName: data.customerName,
    plan: data.plan,
    issuedAt: data.issuedAt,
    startsAt: data.startsAt,
    expiresAt: data.expiresAt,
    deviceId: data.deviceId,
    diskId: data.diskId,
    installPath: data.installPath,
    features: data.features,
  }
  const deviceMatch = data.deviceId.toUpperCase() === identity.installationId.toUpperCase()
  const diskMatch = data.diskId.toUpperCase() === identity.diskId.toUpperCase()
  if (!deviceMatch || !diskMatch) {
    const mismatchReasons: string[] = []
    if (!deviceMatch) mismatchReasons.push("La licencia está vinculada a otra instalación (Installation ID no coincide)")
    if (!diskMatch) mismatchReasons.push("La licencia está vinculada a otro disco (Disk ID no coincide)")
    return { valid: false, status: "mismatch", reasons: mismatchReasons, detail, license: licenseMeta }
  }

  // ---------- 6. installPath: SOLO advertencia (binding opcional) ----------
  const licensePathNorm = normalizeInstallPath(data.installPath)
  if (licensePathNorm !== identity.installPathNormalized) {
    detail.installPathWarning = `La licencia se emitió para la ruta "${data.installPath}" pero la instalación actual está en "${identity.installPath}" (informativo; el binding real es equipo+disco)`
  }

  // ---------- 7. Vigencia (con reloj efectivo anti-rollback) ----------
  const graceMs = licenseGraceHours() * 60 * 60 * 1000
  let status: LicenseValidationResult["status"]
  if (now < startsAt) {
    return {
      valid: false,
      status: "invalid",
      reasons: [`La licencia aún no está vigente (comienza el ${data.startsAt})`],
      detail,
      license: licenseMeta,
    }
  }
  if (now >= expiresAt) {
    status = now < expiresAt + graceMs && graceMs > 0 ? "grace" : "expired"
    return {
      valid: false,
      status,
      reasons: [status === "grace" ? `Licencia vencida (en período de gracia hasta ${new Date(expiresAt + graceMs).toISOString()})` : "Licencia vencida"],
      detail,
      license: licenseMeta,
    }
  }
  status = "active"

  return {
    valid: true,
    status,
    reasons: [],
    detail,
    license: licenseMeta,
  }
}

/** Días restantes de una licencia activa (techo 0, con reloj efectivo). */
export function licenseDaysLeft(expiresAtIso: string, now = Date.now()): number {
  const ms = Date.parse(expiresAtIso) - now
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}
