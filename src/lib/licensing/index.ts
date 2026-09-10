/**
 * ViewLBA — Fachada del sistema de licenciamiento (API interna del servidor).
 *
 * Funciones públicas (sección 9 del requisito):
 *   getInstallationIdentity() · getCurrentLicense() · validateLicense()
 *   getLicenseStatus() · getTrialStatus() · getFeatureAvailability()
 *   importLicenseZip()
 *
 * TODO es 100% OFFLINE: ninguna de estas funciones hace llamadas de red.
 * La TV consulta el estado vía GET /api/license (LAN) — nunca valida sola.
 */
import { analyzeTrial, effectiveTime } from "./trial"
import { getDeviceFingerprint, deriveInstallationId, INSTALLATION_ID_RE } from "./fingerprint"
import { deriveDiskId, getDiskIdHashFor, diskLabelOf, normalizeInstallPath, resolveInstallPath, DISK_ID_RE } from "./disk-binding"
import { validateLicense, licenseDaysLeft } from "./validator"
import { resolveFeatures } from "./features"
import { readZip, findZipEntry } from "./zip"
import { refreshTrialState, readTrialAnchors, PrismaLicenseStore, MemoryLicenseStore } from "./storage"
import { logLicenseEvent } from "./audit"
import {
  CONTACT_PHONE,
  type FeatureAvailability,
  type ImportResult,
  type InstallationIdentity,
  type LicenseHistoryEntry,
  type LicenseRecord,
  type LicenseStatus,
  type LicenseStore,
  type LicenseValidationResult,
  type MergedTrialState,
  type SignedLicense,
  type TrialResult,
} from "./types"

export * from "./types"
export { INSTALLATION_ID_RE, DISK_ID_RE, deriveInstallationId, deriveDiskId }
export { resolveFeatures, FEATURE_KEYS, FEATURE_LABELS } from "./features"

// ---------------------------------------------------------------------------
// Época de estado (invalidación del cache público de /api/license)
// ---------------------------------------------------------------------------

let stateEpoch = 0

/** Invalida los caches derivados del estado (lo llama importLicenseZip). */
export function bumpLicenseStateEpoch(): void {
  stateEpoch += 1
}

/** Época actual — los caches la comparan para auto-invalidarse. */
export function licenseStateEpoch(): number {
  return stateEpoch
}

// ---------------------------------------------------------------------------
// Identidad de instalación
// ---------------------------------------------------------------------------

let identityCache: { key: string; identity: InstallationIdentity } | null = null

/** Identidad ACTUAL de la instalación (fingerprint + disco + ruta). */
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
    installPathNormalized: normalizeInstallPath(installPath),
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
  /** Metadatos de la licencia activa (null si no hay/válida). */
  license: {
    licenseId: string
    customerName: string
    plan: "monthly" | "annual"
    issuedAt: string
    startsAt: string
    expiresAt: string
    deviceId: string
    diskId: string
    installPath: string
    features: Record<string, boolean>
  } | null
  /** Validación completa (solo admin). */
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
}

async function resolveStore(store?: LicenseStore): Promise<LicenseStore> {
  return store ?? new PrismaLicenseStore()
}

/**
 * Estado COMPLETO del sistema de licencias (evaluación autoritativa).
 * El backend es la autoridad local: la UI/TV solo consumen el resultado.
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

  // 3) Validación de la licencia contra el hardware ACTUAL (siempre se
  //    recalcula → un restore/clone en otro disco da MISMATCH)
  let validation: LicenseValidationResult | null = null
  if (record) {
    validation = validateLicense(record.license, identity, { now: effectiveNow })
  }

  // 4) Resolución de estado global
  let status: LicenseStatus
  let reasons: string[] = []
  let licenseMeta: LicenseSystemState["license"] = null
  let daysLeft = 0

  if (validation?.valid) {
    status = validation.status === "grace" ? "grace" : "active"
    licenseMeta = validation.license ?? null
    daysLeft = licenseDaysLeft(licenseMeta!.expiresAt, effectiveNow)
  } else if (validation) {
    // invalid | mismatch | expired | grace (invalid por fechas)
    status = validation.status
    reasons = validation.reasons
    licenseMeta = validation.license ?? null
    daysLeft = 0
    if (validation.status === "expired" && validation.license) {
      daysLeft = 0
    }
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
      const { writeTrialAnchors } = await import("./storage")
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

/** Historial de licencias importadas (DB LicenseHistory). */
export async function getLicenseHistory(opts: { store?: LicenseStore } = {}): Promise<LicenseHistoryEntry[]> {
  const store = await resolveStore(opts.store)
  return store.listHistory().catch(() => [])
}

// ---------------------------------------------------------------------------
// Importación de licencia (ZIP → validación TOTAL → guardado)
// ---------------------------------------------------------------------------

export interface ImportLicenseOptions {
  /** Actor admin que importa (auditoría). */
  actor?: { uid: string; name: string } | null
  now?: number
  store?: LicenseStore
  identity?: InstallationIdentity
  publicKey?: string
  anchorPaths?: string[]
  /** Desactiva auditoría/realtime (tests puros, sin DB). */
  silent?: boolean
}

/**
 * Importa una licencia desde el ZIP entregado al cliente:
 *  1. Lee el ZIP (CRC verificado) y extrae license.json.
 *  2. Valida firma, esquema, producto, fechas, Installation ID y Disk ID
 *     contra el hardware ACTUAL (sección 15: SOLO guardar si TODO pasa).
 *  3. Regla anti-downgrade: no acortar la vigencia de una licencia activa.
 *  4. Persiste licencia + historial y notifica a las pantallas (realtime).
 */
export async function importLicenseZip(zipBuffer: Buffer, opts: ImportLicenseOptions = {}): Promise<ImportResult> {
  const now = opts.now ?? Date.now()
  const identity = opts.identity ?? (await getInstallationIdentity())
  const store = opts.store ?? new PrismaLicenseStore()
  const actorLabel = opts.actor?.name ?? "sistema"

  const reject = async (reasons: string[], metaExtra: Record<string, unknown> = {}): Promise<ImportResult> => {
    if (!opts.silent) {
      await logLicenseEvent("license_rejected", {
        actor: opts.actor ?? null,
        details: reasons[0],
        meta: { reasons, actor: actorLabel, ...metaExtra },
      })
    }
    return { ok: false, reasons }
  }

  // ---------- 1. ZIP ----------
  let entries
  try {
    entries = readZip(zipBuffer)
  } catch (e) {
    return reject([`El ZIP de la licencia es inválido o está corrupto: ${(e as Error).message}`])
  }
  const licenseEntry = findZipEntry(entries, "license.json")
  if (!licenseEntry) {
    return reject(["El ZIP no contiene license.json — usa el archivo entregado por el proveedor (ViewLBA-License-….zip)"])
  }

  let licenseJson: unknown
  try {
    licenseJson = JSON.parse(licenseEntry.data.toString("utf8"))
  } catch {
    return reject(["license.json no es un JSON válido"])
  }

  // ---------- 2. Validación TOTAL ----------
  const validation = validateLicense(licenseJson, identity, { now, publicKey: opts.publicKey })
  if (!validation.valid) {
    // IMPORTANTE: no persistir NADA si algo falla
    return reject(validation.reasons, {
      expected: { installationId: identity.installationId, diskId: identity.diskId },
      found: { installationId: validation.detail?.foundInstallationId, diskId: validation.detail?.foundDiskId },
    })
  }
  const license = licenseJson as SignedLicense

  // ---------- 3. Anti-downgrade ----------
  const current = await store.getLicenseRecord().catch(() => null)
  if (current) {
    const currentValidation = validateLicense(current.license, identity, { now, publicKey: opts.publicKey })
    const currentActive = currentValidation.valid || currentValidation.status === "grace"
    if (currentActive) {
      const currentExpiry = Date.parse(current.license.expiresAt)
      const newExpiry = Date.parse(license.expiresAt)
      if (newExpiry < currentExpiry && current.license.licenseId !== license.licenseId) {
        return reject([
          "La nueva licencia vence ANTES que la actual activa (downgrade no permitido). Solicita una licencia con vigencia igual o superior.",
        ])
      }
    }
  }

  // ---------- 4. Persistencia (todo pasó) ----------
  const importedAt = new Date(now).toISOString()
  await store.saveLicenseRecord({ license, importedAt, importedBy: actorLabel })
  await store
    .appendHistory({
      licenseId: license.licenseId,
      customerName: license.customerName,
      plan: license.plan,
      issuedAt: license.issuedAt,
      startsAt: license.startsAt,
      expiresAt: license.expiresAt,
      deviceId: license.deviceId,
      diskId: license.diskId,
      importedAt,
      current: true,
    })
    .catch(() => {})

  // ---------- 5. Auditoría + refresco realtime de las TVs ----------
  if (!opts.silent) {
    await logLicenseEvent("license_imported", {
      actor: opts.actor ?? null,
      details: `${license.customerName} · ${license.plan} · vence ${license.expiresAt.slice(0, 10)}`,
      meta: { licenseId: license.licenseId, plan: license.plan, expiresAt: license.expiresAt },
    })
    try {
      const { notifyContentUpdate } = await import("@/lib/realtime")
      await notifyContentUpdate("license")
    } catch {
      // realtime caído: las TVs refrescan por polling — no es bloqueante
    }
  }
  bumpLicenseStateEpoch()

  return {
    ok: true,
    reasons: [],
    summary: {
      licenseId: license.licenseId,
      customerName: license.customerName,
      plan: license.plan,
      startsAt: license.startsAt,
      expiresAt: license.expiresAt,
      daysLeft: licenseDaysLeft(license.expiresAt, now),
    },
  }
}

// Re-exporta utilidades usadas por el generador/tests
export { MemoryLicenseStore, PrismaLicenseStore } from "./storage"
export { generateLicenseKeyPair, signLicense, verifyLicenseSignature, resolveVerifierPublicKey, newLicenseId, randomHex, sha256Hex } from "./crypto"
export { canonicalizeLicensePayload, stripSignature } from "./canonical"
export { buildZip, readZip, findZipEntry, crc32 } from "./zip"
export { validateLicense, licenseDaysLeft } from "./validator"
export { normalizeInstallPath } from "./disk-binding"
export { CONTACT_PHONE }
