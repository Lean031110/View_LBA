/**
 * ViewLBA — Fachada del sistema de licenciamiento v2 (API interna).
 *
 * Funciones públicas:
 *   getInstallationIdentity() · getLicenseSystemState() · getLicenseStatus()
 *   getTrialStatus() · getCurrentLicense() · getFeatureAvailability()
 *   getLicenseHistory() · buildLicenseRequestCode() · activateLicenseToken()
 *
 * FLUJO (cero ZIP, cero JSON visible, cero Installation/Disk ID en la UI):
 *   cliente copia código  →  admin genera token en Android  →  cliente pega
 *   token  →  activateLicenseToken() valida TODO  →  LICENCIA ACTIVA.
 *
 * TODO es 100% OFFLINE: ninguna de estas funciones hace llamadas de red.
 * La TV consulta el estado vía GET /api/license (LAN) — nunca valida sola.
 */
import { analyzeTrial, effectiveTime } from "./trial"
import { getDeviceFingerprint, deriveInstallationId } from "./fingerprint"
import { deriveDiskId, getDiskIdHashFor, diskLabelOf, normalizeInstallPath, resolveInstallPath } from "./disk-binding"
import { validateLicenseToken, verifyLicenseToken, licenseDaysLeft, formatDay, decodeErrorToRejectCode } from "./validator"
import { resolveFeatures } from "./features"
import { refreshTrialState, readTrialAnchors, writeTrialAnchors, PrismaLicenseStore, MemoryLicenseStore } from "./storage"
import { logLicenseEvent } from "./audit"
import { buildRequestCode, type BuildRequestCodeInput } from "./request-code"
import { normalizeLicenseToken } from "./token"
import { TokenDecodeError } from "./types"
import {
  CONTACT_PHONE,
  type ActivationResult,
  type FeatureAvailability,
  type InstallationIdentity,
  type LicenseHistoryEntry,
  type LicenseRecord,
  type LicenseStatus,
  type LicenseStore,
  type LicenseSummary,
  type LicenseTokenPayload,
  type LicenseValidationResult,
  type TrialResult,
} from "./types"

export * from "./types"
export { INSTALLATION_ID_RE, deriveInstallationId } from "./fingerprint"
export { DISK_ID_RE, deriveDiskId } from "./disk-binding"
export { resolveFeatures, FEATURE_KEYS, FEATURE_LABELS } from "./features"
export {
  buildRequestCode,
  openRequestCode,
  normalizeRequestCode,
  REQUEST_CODE_MAX_AGE_DAYS,
  REQUEST_CUSTOMER_NAME_MIN,
  REQUEST_CUSTOMER_NAME_MAX,
} from "./request-code"
export { buildLicenseToken, decodeLicenseToken, normalizeLicenseToken } from "./token"

// ---------------------------------------------------------------------------
// Época de estado (invalidación del cache público de /api/license)
// ---------------------------------------------------------------------------

let stateEpoch = 0

/** Invalida los caches derivados del estado (lo llama activateLicenseToken). */
export function bumpLicenseStateEpoch(): void {
  stateEpoch += 1
}

/** Época actual — los caches la comparan para auto-invalidarse. */
export function licenseStateEpoch(): number {
  return stateEpoch
}

// ---------------------------------------------------------------------------
// Identidad de instalación (interna — JAMÁS expuesta al cliente)
// ---------------------------------------------------------------------------

let identityCache: { key: string; identity: InstallationIdentity } | null = null

/** Identidad ACTUAL de la instalación (fingerprint + disco). */
export async function getInstallationIdentity(): Promise<InstallationIdentity> {
  const installPath = resolveInstallPath()
  const cacheKey = `${installPath}|${process.env.VIEWLBA_TEST_DEVICE_FINGERPRINT ?? ""}|${process.env.VIEWLBA_TEST_DISK_ID_HASH ?? ""}`
  if (identityCache?.key === cacheKey) return identityCache.identity

  const { deviceIdHash, method } = await getDeviceFingerprint()
  const { diskIdHash, binding } = await getDiskIdHashFor(installPath)

  const identity: InstallationIdentity = {
    deviceIdHash,
    installationId: deriveInstallationId(deviceIdHash),
    fingerprintMethod: method,
    diskIdHash,
    diskId: deriveDiskId(diskIdHash),
    diskLabel: diskLabelOf(binding),
    diskBindingMethod: binding.method,
    installPath,
  }
  identityCache = { key: cacheKey, identity }
  return identity
}

/** Invalida la cache de identidad (tests). */
export function __resetIdentityCacheForTests(): void {
  identityCache = null
}

// ---------------------------------------------------------------------------
// Estado global del sistema de licencias
// ---------------------------------------------------------------------------

export interface LicenseSystemState {
  status: LicenseStatus
  /** Motivos del estado actual (legibles, es-ES). */
  reasons: string[]
  trial: TrialResult | null
  /** Reloj efectivo (ms epoch, anti-rollback). */
  effectiveNow: number
  clockTampered: boolean
  /** Payload de la licencia guardada (null si no hay/válida). */
  license: LicenseTokenPayload | null
  /** Validación completa (solo admin interno). */
  validation: LicenseValidationResult | null
  /** Días restantes (licencia o trial). */
  daysLeft: number
  features: FeatureAvailability
}

export interface GetLicenseStateOptions {
  now?: number
  store?: LicenseStore
  anchorPaths?: string[]
  identity?: InstallationIdentity
  /** Desactiva la auditoría de transiciones (tests puros). */
  silent?: boolean
  /** Clave pública alternativa (tests). */
  publicKey?: string
}

async function resolveStore(store?: LicenseStore): Promise<LicenseStore> {
  return store ?? new PrismaLicenseStore()
}

/**
 * Estado COMPLETO del sistema de licencias (evaluación autoritativa).
 * El backend es la autoridad local: la UI/TV solo consumen el resultado.
 * El token guardado se REVALIDA (firma + binding) en cada evaluación.
 */
export async function getLicenseSystemState(opts: GetLicenseStateOptions = {}): Promise<LicenseSystemState> {
  const now = opts.now ?? Date.now()
  const identity = opts.identity ?? (await getInstallationIdentity())
  const store = await resolveStore(opts.store)

  // 1) Licencia guardada en el servidor (DB)
  const record = await store.getLicenseRecord().catch(() => null)

  // 2) Trial: anclas + high-water anti-rollback + eventos
  const refresh = refreshTrialState(identity.deviceIdHash, {
    now,
    hasLicense: !!record,
    anchorPaths: opts.anchorPaths,
    onEvent: opts.silent
      ? undefined
      : (event, meta) => {
          void logLicenseEvent(event, { meta })
        },
  })
  const merged = refresh.merged
  const effectiveNow = effectiveTime(now, merged.lastSeenAt, merged.clockTampered)

  // 3) Validación del token guardado contra el hardware ACTUAL (siempre se
  //    recalcula → un restore/clone en otro disco da MISMATCH)
  let validation: LicenseValidationResult | null = null
  if (record) {
    try {
      validation = validateLicenseToken(record.token, identity, { now: effectiveNow, publicKey: opts.publicKey })
    } catch {
      // Token corrupto en DB (decodificación imposible) → inválido
      validation = { valid: false, status: "invalid", reasons: ["La licencia guardada no se puede leer (datos corruptos)"] }
    }
  }

  // 4) Resolución de estado global
  let status: LicenseStatus
  let reasons: string[] = []
  let licenseMeta: LicenseTokenPayload | null = null
  let daysLeft = 0

  if (validation?.valid) {
    status = validation.status === "grace" ? "grace" : "active"
    licenseMeta = validation.payload ?? null
    daysLeft = licenseDaysLeft(licenseMeta!.expiresAt, effectiveNow)
  } else if (validation) {
    // invalid | mismatch | expired | grace (invalid por fechas)
    status = validation.status
    reasons = validation.reasons
    licenseMeta = validation.payload ?? null
    daysLeft = 0
  } else {
    // Sin licencia comercial → trial (agotado = unlicensed)
    const trial = refresh.analysis
    status = trial.active ? "trial" : "unlicensed"
    if (status === "trial") daysLeft = trial.daysLeft
    if (merged.integrityWarnings > 0) {
      reasons.push("Se detectaron indicios de manipulación en los archivos de prueba del equipo")
    }
  }

  // 5) Auditoría de transiciones (una vez por cambio de estado)
  if (!opts.silent) {
    const events: Array<{ status: string; event: Parameters<typeof logLicenseEvent>[0] }> = [
      { status: "expired", event: "license_expired" },
      { status: "mismatch", event: "license_mismatch" },
    ]
    const transition = events.find((e) => e.status === status)
    if (transition && merged.lastLoggedStatus !== status) {
      // persistir el estado ya registrado para no repetir el evento
      writeTrialAnchors(identity.deviceIdHash, {
        trialStartAt: merged.trialStartAt,
        lastSeenAt: merged.lastSeenAt,
        clockTampered: merged.clockTampered,
        lastLoggedStatus: status,
      })
      await logLicenseEvent(transition.event, { meta: { status, reasons } })
    }
  }

  // 6) Features resueltas para el estado
  const features = resolveFeatures({
    status,
    licenseFeatures: licenseMeta?.features ?? null,
    trialDaysLeft: status === "trial" ? daysLeft : undefined,
  })

  return {
    status,
    reasons,
    trial: record ? null : refresh.analysis,
    effectiveNow,
    clockTampered: merged.clockTampered,
    license: licenseMeta,
    validation,
    daysLeft,
    features,
  }
}

/** Alias legible: estado resumido de licencia. */
export async function getLicenseStatus(opts: GetLicenseStateOptions = {}): Promise<LicenseStatus> {
  return (await getLicenseSystemState(opts)).status
}

/** Estado del trial (sin tocar la licencia). */
export async function getTrialStatus(opts: GetLicenseStateOptions = {}): Promise<TrialResult | null> {
  const identity = opts.identity ?? (await getInstallationIdentity())
  const store = await resolveStore(opts.store)
  const record = await store.getLicenseRecord().catch(() => null)
  const { merged } = readTrialAnchors(identity.deviceIdHash, opts.anchorPaths)
  return analyzeTrial({ merged, now: opts.now ?? Date.now() })
}

/** Licencia actualmente guardada (tal cual, sin validar). */
export async function getCurrentLicense(opts: { store?: LicenseStore } = {}): Promise<LicenseRecord | null> {
  const store = await resolveStore(opts.store)
  return store.getLicenseRecord().catch(() => null)
}

/** Disponibilidad de features para el estado actual. */
export async function getFeatureAvailability(opts: GetLicenseStateOptions = {}): Promise<FeatureAvailability> {
  return (await getLicenseSystemState(opts)).features
}

/** Historial de licencias activadas (DB LicenseHistory). */
export async function getLicenseHistory(opts: { store?: LicenseStore } = {}): Promise<LicenseHistoryEntry[]> {
  const store = await resolveStore(opts.store)
  return store.listHistory().catch(() => [])
}

// ---------------------------------------------------------------------------
// Código de solicitud (POST /api/license/request-code)
// ---------------------------------------------------------------------------

/**
 * Construye el código de solicitud VLREQ2 del ESTE equipo con el nombre del
 * negocio indicado. La identidad (installationId/diskId) se genera aquí —
 * el cliente NUNCA la copia a mano ni la ve.
 */
export async function buildLicenseRequestCode(input: Omit<BuildRequestCodeInput, "installationId" | "diskId"> & { identity?: InstallationIdentity }): Promise<string> {
  const identity = input.identity ?? (await getInstallationIdentity())
  return buildRequestCode({
    customerName: input.customerName,
    installationId: identity.installationId,
    diskId: identity.diskId,
    now: input.now,
    requestPublicKey: input.requestPublicKey,
    nonce: input.nonce,
  })
}

// ---------------------------------------------------------------------------
// Activación de licencia (POST /api/license/activate)
// ---------------------------------------------------------------------------

export interface ActivateLicenseOptions {
  /** Actor admin que activa (auditoría). */
  actor?: { uid: string; name: string } | null
  now?: number
  store?: LicenseStore
  identity?: InstallationIdentity
  publicKey?: string
  anchorPaths?: string[]
  /** Desactiva auditoría/realtime (tests puros, sin DB). */
  silent?: boolean
}

function summaryOf(payload: LicenseTokenPayload, daysLeft: number): LicenseSummary {
  return {
    licenseId: payload.licenseId,
    customerName: payload.customerName,
    plan: payload.plan,
    durationDays: payload.durationDays,
    issuedAt: payload.issuedAt,
    startsAt: payload.startsAt,
    expiresAt: payload.expiresAt,
    daysLeft,
    features: payload.features,
  }
}

const PLAN_LABEL: Record<string, string> = { monthly: "Mensual", annual: "Anual", custom: "Personalizada" }

/**
 * Activa una licencia desde el token VLBA2 pegado por el cliente.
 *
 * Pipeline (TODO debe pasar; si algo falla NO se persiste NADA):
 *   1.  formato (prefijo/charset/longitud)
 *   2.  trama (magic/versión/CRC32)
 *   3.  firma Ed25519
 *   4.  esquema (zod)
 *   5.  producto
 *   6.  fechas/duración
 *   7.  binding (installationId + diskId vs hardware ACTUAL)
 *   8.  anti-replay/duplicado (licenseId)
 *   9.  anti-downgrade (no acortar una licencia activa)
 *   10. guardar licencia + historial
 *   11. auditoría
 *   12. resumen seguro (sin datos de binding)
 */
export async function activateLicenseToken(token: string, opts: ActivateLicenseOptions = {}): Promise<ActivationResult> {
  const now = opts.now ?? Date.now()
  const identity = opts.identity ?? (await getInstallationIdentity())
  const store = opts.store ?? new PrismaLicenseStore()
  const actorLabel = opts.actor?.name ?? "sistema"

  const reject = async (code: NonNullable<ActivationResult["code"]>, reason: string, metaExtra: Record<string, unknown> = {}): Promise<ActivationResult> => {
    if (!opts.silent) {
      await logLicenseEvent("license_rejected", {
        actor: opts.actor ?? null,
        details: reason,
        meta: { code, reason, actor: actorLabel, ...metaExtra },
      })
    }
    return { ok: false, code, reason }
  }

  // ---------- 0. Entrada ----------
  if (typeof token !== "string" || token.trim().length === 0) {
    return reject("empty_token", "Pega el token de licencia que te envió el proveedor")
  }
  if (token.length > 8192) {
    return reject("too_long", "El token pegado es demasiado largo — no parece un token ViewLBA")
  }

  // ---------- 1-2. Trama estructural ----------
  let validation: LicenseValidationResult
  try {
    validation = verifyLicenseToken(token, { now, publicKey: opts.publicKey })
  } catch (e) {
    if (e instanceof TokenDecodeError) {
      return reject(decodeErrorToRejectCode(e), e.message)
    }
    return reject("bad_frame", "El token no se puede interpretar")
  }

  // ---------- 3-6. Firma / esquema / producto / fechas ----------
  if (!validation.valid) {
    return reject("bad_signature", validation.reasons[0] ?? "El token no es válido")
  }
  const payload = validation.payload!

  // ---------- 7. Binding contra el hardware ACTUAL ----------
  const deviceMatch = payload.installationId.toUpperCase() === identity.installationId.toUpperCase()
  const diskMatch = payload.diskId.toUpperCase() === identity.diskId.toUpperCase()
  if (!deviceMatch || !diskMatch) {
    return reject("binding_mismatch", "El token de licencia NO corresponde a este equipo — solicita uno nuevo para esta instalación", {
      expected: { installationId: identity.installationId, diskId: identity.diskId },
      found: { installationId: payload.installationId, diskId: payload.diskId },
    })
  }

  // Vigencia al momento de activar (con reloj efectivo)
  if (payload.startsAt > now) {
    return reject("not_started", `La licencia comienza el ${formatDay(payload.startsAt)} — actívala a partir de esa fecha`)
  }
  if (payload.expiresAt <= now) {
    return reject("already_expired", "La licencia está vencida — solicita una renovación")
  }

  // ---------- 8. Anti-replay / duplicado ----------
  const normalized = normalizeLicenseToken(token)!
  const current = await store.getLicenseRecord().catch(() => null)

  if (current) {
    // Re-activación idempotente del MISMO token (el cliente lo pegó dos veces)
    if (current.token.replace(/-/g, "") === normalized) {
      return {
        ok: true,
        alreadyActive: true,
        summary: summaryOf(current.payload, licenseDaysLeft(current.payload.expiresAt, now)),
      }
    }
    // Mismo licenseId con token distinto → colisión, rechazar
    if (current.payload.licenseId === payload.licenseId) {
      return reject("duplicate_license", "Ya existe una licencia con este identificador — usa el token más reciente que te envió el proveedor")
    }
  }

  const historyHit = await store.findHistoryByLicenseId(payload.licenseId).catch(() => null)
  if (historyHit) {
    return reject("duplicate_license", "Este token ya fue activado antes en este servidor — solicita una emisión nueva (renovación)")
  }

  // ---------- 9. Anti-downgrade ----------
  if (current) {
    const currentValidation = validateLicenseToken(current.token, identity, { now, publicKey: opts.publicKey })
    const currentActive = currentValidation.valid || currentValidation.status === "grace"
    if (currentActive && payload.expiresAt < current.payload.expiresAt && current.payload.licenseId !== payload.licenseId) {
      return reject("downgrade", "La nueva licencia vence ANTES que la actual activa — solicita una renovación con vigencia igual o superior")
    }
  }

  // ---------- 10. Persistencia (todo pasó) ----------
  const activatedAt = new Date(now).toISOString()
  await store.saveLicenseRecord({ token: normalized, payload, activatedAt, activatedBy: actorLabel })
  await store
    .appendHistory({
      licenseId: payload.licenseId,
      customerName: payload.customerName,
      plan: payload.plan,
      durationDays: payload.durationDays,
      issuedAt: payload.issuedAt,
      startsAt: payload.startsAt,
      expiresAt: payload.expiresAt,
      installationId: payload.installationId,
      diskId: payload.diskId,
      activatedAt: now,
      activatedBy: actorLabel,
      current: true,
    })
    .catch(() => {})

  // ---------- 11. Auditoría + refresco realtime de las TVs ----------
  if (!opts.silent) {
    await logLicenseEvent("license_activated", {
      actor: opts.actor ?? null,
      details: `${payload.customerName} · ${PLAN_LABEL[payload.plan] ?? payload.plan} · ${payload.durationDays} días · vence ${formatDay(payload.expiresAt)}`,
      meta: { licenseId: payload.licenseId, plan: payload.plan, durationDays: payload.durationDays, expiresAt: payload.expiresAt },
    })
    try {
      const { notifyContentUpdate } = await import("@/lib/realtime")
      await notifyContentUpdate("license")
    } catch {
      // realtime caído: las TVs refrescan por polling — no es bloqueante
    }
  }
  bumpLicenseStateEpoch()

  // ---------- 12. Resumen seguro ----------
  return {
    ok: true,
    summary: summaryOf(payload, licenseDaysLeft(payload.expiresAt, now)),
  }
}

// Re-exporta utilidades usadas por tests/e2e
export { MemoryLicenseStore, PrismaLicenseStore } from "./storage"
export {
  generateLicenseKeyPair,
  generateRequestKeyPair,
  signTokenPayload,
  verifyTokenSignature,
  sealRequestPayload,
  openSealedRequest,
  resolveVerifierPublicKey,
  resolveRequestPublicKey,
  newLicenseId,
  randomHex,
  sha256Hex,
} from "./crypto"
export { canonicalize, sortKeysDeep } from "./canonical"
export { crc32, base32Encode, base32DecodeStrict, formatWithDashes, normalizeTokenInput } from "./codec"
export { validateLicenseToken, verifyLicenseToken, licenseDaysLeft, formatDay, licenseGraceHours } from "./validator"
export { CONTACT_PHONE }
