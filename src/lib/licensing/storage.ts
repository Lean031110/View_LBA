/**
 * ViewLBA — Persistencia del estado de licenciamiento (lado SERVIDOR).
 *
 * ARQUITECTURA DE AUTORIDAD:
 *  · Licencia comercial → DB SQLite (Prisma: LicenseState + LicenseHistory).
 *    Se guarda el token VLBA2 original + el payload decodificado; el token
 *    se REVALIDA (firma + binding contra hardware/disco ACTUAL) en CADA
 *    evaluación → un restore/clone de DB en otra máquina da MISMATCH.
 *  · Trial → ANCLAS de archivo FUERA de la DB (2 ubicaciones):
 *      1. <DATA_DIR>/licensing/state.json   (junto a la instalación)
 *      2. ~/.viewlba-license.json           (home del usuario, sobrevive a
 *         reinstalaciones superficiales de la app)
 *    Fusión: earliest trialStartAt / max lastSeenAt / flags sticky →
 *    borrar UNA ancla NO reinicia el trial.
 *  · Cada ancla lleva HMAC-SHA256(deviceIdHash + AUTH_SECRET): la edición
 *    casual del JSON se detecta (integrityWarnings).
 *
 * Este módulo NO importa Prisma directamente (import dinámico) para que los
 * tests unitarios puros no arranquen la DB.
 */
import { createHmac, createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  MergedTrialState,
  TrialAnchorState,
  LicenseHistoryEntry,
  LicenseRecord,
  LicenseStore,
  type LicenseAuditEvent,
} from "./types"
import { analyzeTrial, detectClockRollback, CLOCK_TAMPER_TOLERANCE_MS } from "./trial"

// ---------------------------------------------------------------------------
// Directorios y rutas de anclas
// ---------------------------------------------------------------------------

/** Directorio de datos (mismo criterio que media.ts: DATA_DIR o cwd/data). */
export function resolveDataDir(): string {
  const configured = process.env.DATA_DIR?.trim()
  return configured ? join(process.cwd(), configured) : join(process.cwd(), "data")
}

/** Rutas por defecto de las anclas de trial (2 ubicaciones independientes). */
export function defaultAnchorPaths(): string[] {
  return [join(resolveDataDir(), "licensing", "state.json"), join(homedir(), ".viewlba-license.json")]
}

// ---------------------------------------------------------------------------
// Sello HMAC de integridad de anclas
// ---------------------------------------------------------------------------

function anchorStampKey(deviceIdHash: string): Buffer {
  // Mezcla hardware + AUTH_SECRET local: copiar la ancla a otra máquina
  // (otro deviceIdHash) o editarla a mano sin el secreto rompe el sello.
  const authSecret = process.env.AUTH_SECRET ?? ""
  return createHash("sha256").update(`${deviceIdHash}|${authSecret}`).digest()
}

function canonicalAnchorBody(state: Omit<TrialAnchorState, "stamp">): string {
  return JSON.stringify([state.v, state.deviceIdHash, state.trialStartAt, state.lastSeenAt, state.clockTampered, state.lastLoggedStatus ?? null])
}

export function computeAnchorStamp(state: Omit<TrialAnchorState, "stamp">): string {
  return createHmac("sha256", anchorStampKey(state.deviceIdHash)).update(canonicalAnchorBody(state)).digest("hex")
}

function anchorStampValid(state: TrialAnchorState): boolean {
  try {
    const { stamp, ...body } = state
    return typeof stamp === "string" && stamp === computeAnchorStamp(body)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Lectura / fusión de anclas
// ---------------------------------------------------------------------------

export interface ReadAnchorsResult {
  merged: MergedTrialState
}

function parseAnchor(raw: string): TrialAnchorState | null {
  try {
    const obj = JSON.parse(raw) as TrialAnchorState
    if (obj?.v !== 1 || typeof obj.deviceIdHash !== "string") return null
    return {
      v: 1,
      deviceIdHash: obj.deviceIdHash,
      trialStartAt: typeof obj.trialStartAt === "number" ? obj.trialStartAt : null,
      lastSeenAt: typeof obj.lastSeenAt === "number" ? obj.lastSeenAt : null,
      clockTampered: obj.clockTampered === true,
      lastLoggedStatus: typeof obj.lastLoggedStatus === "string" ? obj.lastLoggedStatus : null,
      stamp: typeof obj.stamp === "string" ? obj.stamp : "",
    }
  } catch {
    return null
  }
}

/**
 * Lee todas las anclas y las FUSIONA (anti-borrado casual):
 *  · trialStartAt: el MÍNIMO visto (nunca se adelanta el inicio del trial)
 *  · lastSeenAt: el MÁXIMO visto (high-water anti-rollback)
 *  · clockTampered / lastLoggedStatus: sticky
 *  · Anclas con deviceIdHash ajeno se ignoran (máquina distinta)
 *  · Anclas con sello inválido: solo cuentan como integrityWarning
 */
export function readTrialAnchors(deviceIdHash: string, paths: string[] = defaultAnchorPaths()): ReadAnchorsResult {
  const merged: MergedTrialState = {
    trialStartAt: null,
    lastSeenAt: null,
    clockTampered: false,
    lastLoggedStatus: null,
    integrityWarnings: 0,
    anchorsFound: 0,
  }

  for (const path of paths) {
    let raw: string | null = null
    try {
      if (existsSync(path)) raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    if (raw == null) continue
    const anchor = parseAnchor(raw)
    if (!anchor) {
      merged.integrityWarnings += 1 // ilegible = sospechoso
      continue
    }
    if (anchor.deviceIdHash.toLowerCase() !== deviceIdHash.toLowerCase()) continue // ancla ajena
    if (!anchorStampValid(anchor)) {
      merged.integrityWarnings += 1 // editada a mano: no confiar en su contenido
      continue
    }
    merged.anchorsFound += 1
    if (anchor.trialStartAt != null) {
      merged.trialStartAt = merged.trialStartAt == null ? anchor.trialStartAt : Math.min(merged.trialStartAt, anchor.trialStartAt)
    }
    if (anchor.lastSeenAt != null) {
      merged.lastSeenAt = merged.lastSeenAt == null ? anchor.lastSeenAt : Math.max(merged.lastSeenAt, anchor.lastSeenAt)
    }
    merged.clockTampered = merged.clockTampered || anchor.clockTampered
    if (anchor.lastLoggedStatus) merged.lastLoggedStatus = anchor.lastLoggedStatus
  }

  return { merged }
}

/**
 * Escribe el estado de ancla en TODAS las rutas (write atómico rename).
 * Best-effort por ruta: si el home no es escribible, la otra ancla basta.
 */
export function writeTrialAnchors(
  deviceIdHash: string,
  state: Omit<TrialAnchorState, "stamp" | "deviceIdHash" | "v">,
  paths: string[] = defaultAnchorPaths()
): void {
  const body: Omit<TrialAnchorState, "stamp"> = { v: 1, deviceIdHash, ...state }
  const stamped: TrialAnchorState = { ...body, stamp: computeAnchorStamp(body) }
  const json = JSON.stringify(stamped, null, 2)
  for (const path of paths) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${Date.now()}`
      writeFileSync(tmp, json, { encoding: "utf8" })
      renameSync(tmp, path)
    } catch {
      // ruta no escribible: la otra ancla mantiene el estado
    }
  }
}

// ---------------------------------------------------------------------------
// Refresh del estado de trial (lectura + decisión + persistencia + eventos)
// ---------------------------------------------------------------------------

export interface RefreshTrialOptions {
  /** Reloj real actual. */
  now?: number
  /** ¿Existe licencia comercial guardada? (si true, NO se arranca trial). */
  hasLicense?: boolean
  /** Rutas de anclas (tests). */
  anchorPaths?: string[]
  /** Callback de auditoría (inyectado para no acoplar storage→logger). */
  onEvent?: (event: LicenseAuditEvent, meta: Record<string, unknown>) => void
  /** Throttle de escritura de lastSeenAt (default 60s). */
  lastSeenWriteIntervalMs?: number
}

export interface RefreshTrialResult {
  merged: MergedTrialState
  /** El refresh arrancó el trial en esta llamada. */
  trialJustStarted: boolean
  /** Se detectó rollback de reloj en esta llamada. */
  rollbackDetected: boolean
  analysis: ReturnType<typeof analyzeTrial>
}

const DEFAULT_WRITE_INTERVAL = 60_000

/**
 * Lee anclas, detecta tamper de reloj, arranca el trial si procede y
 * persiste el high-water (throttled). Devuelve el análisis vigente.
 */
export function refreshTrialState(deviceIdHash: string, opts: RefreshTrialOptions = {}): RefreshTrialResult {
  const now = opts.now ?? Date.now()
  const paths = opts.anchorPaths ?? defaultAnchorPaths()
  const interval = opts.lastSeenWriteIntervalMs ?? DEFAULT_WRITE_INTERVAL

  const { merged } = readTrialAnchors(deviceIdHash, paths)

  // 1) Detección de rollback (antes de arrancar nada)
  const rollbackDetected = detectClockRollback(now, merged.lastSeenAt, CLOCK_TAMPER_TOLERANCE_MS)
  const becameTampered = rollbackDetected && !merged.clockTampered

  let trialJustStarted = false
  // ⚠ Seguridad: si hay anclas con sello inválido (edición manual sospechosa)
  // NO se otorga un trial nuevo — manipular los archivos nunca da más días.
  if (
    merged.trialStartAt == null &&
    !opts.hasLicense &&
    !merged.clockTampered &&
    !rollbackDetected &&
    merged.integrityWarnings === 0
  ) {
    // Primer arranque sin licencia comercial → trial único por instalación
    merged.trialStartAt = now
    trialJustStarted = true
  }

  // 2) ¿Hay que escribir?
  const needsWrite =
    trialJustStarted ||
    becameTampered ||
    (merged.lastSeenAt == null) ||
    now - merged.lastSeenAt >= interval ||
    now < (merged.lastSeenAt ?? 0) // nunca ocurre escribir hacia atrás (protección)

  if (needsWrite) {
    merged.lastSeenAt = Math.max(now, merged.lastSeenAt ?? 0)
    if (becameTampered) merged.clockTampered = true
    writeTrialAnchors(
      deviceIdHash,
      {
        trialStartAt: merged.trialStartAt,
        lastSeenAt: merged.lastSeenAt,
        clockTampered: merged.clockTampered,
        lastLoggedStatus: merged.lastLoggedStatus ?? null,
      },
      paths
    )
  }

  // 3) Eventos de auditoría
  if (opts.onEvent) {
    if (trialJustStarted) opts.onEvent("trial_started", { trialStartAt: merged.trialStartAt })
    if (becameTampered) {
      opts.onEvent("clock_tampering_detected", { lastSeenAt: merged.lastSeenAt, observedNow: now })
    }
  }

  // 4) Análisis con reloj efectivo
  const analysis = analyzeTrial({ merged, now })

  // 5) trial_expired (transición una sola vez — via lastLoggedStatus en ancla)
  if (opts.onEvent && analysis.ended && merged.lastLoggedStatus !== "trial_expired" && merged.trialStartAt != null && !opts.hasLicense) {
    merged.lastLoggedStatus = "trial_expired"
    writeTrialAnchors(
      deviceIdHash,
      {
        trialStartAt: merged.trialStartAt,
        lastSeenAt: merged.lastSeenAt ?? now,
        clockTampered: merged.clockTampered,
        lastLoggedStatus: merged.lastLoggedStatus,
      },
      paths
    )
    opts.onEvent("trial_expired", { endedAt: analysis.endsAt })
  }

  return { merged, trialJustStarted, rollbackDetected, analysis }
}

// ---------------------------------------------------------------------------
// Almacén Prisma (autoridad del servidor) — import DINÁMICO de la DB
// ---------------------------------------------------------------------------

interface PrismaLicenseStateRow {
  id: string
  token: string | null
  payloadJson: string | null
  activatedAt: Date | null
  activatedBy: string | null
}

interface PrismaLicenseHistoryRow {
  id: string
  licenseId: string
  customerName: string
  plan: string
  durationDays: number
  issuedAt: Date
  startsAt: Date
  expiresAt: Date
  installationId: string
  diskId: string
  activatedAt: Date
  activatedBy: string | null
  current: boolean
}

async function getPrisma() {
  const { db } = await import("@/lib/db")
  return db
}

/** Implementación LicenseStore sobre Prisma (LicenseState/LicenseHistory). */
export class PrismaLicenseStore implements LicenseStore {
  async getLicenseRecord(): Promise<LicenseRecord | null> {
    const db = await getPrisma()
    const row = (await db.licenseState.findUnique({ where: { id: "main" } })) as PrismaLicenseStateRow | null
    if (!row?.token || !row?.payloadJson) return null
    try {
      const payload = JSON.parse(row.payloadJson)
      return { token: row.token, payload, activatedAt: (row.activatedAt ?? new Date()).toISOString(), activatedBy: row.activatedBy }
    } catch {
      return null // JSON corrupto en DB → tratar como sin licencia (se re-activa)
    }
  }

  async saveLicenseRecord(record: LicenseRecord): Promise<void> {
    const db = await getPrisma()
    const data = {
      token: record.token,
      payloadJson: JSON.stringify(record.payload),
      activatedAt: new Date(record.activatedAt),
      activatedBy: record.activatedBy,
    }
    await db.licenseState.upsert({
      where: { id: "main" },
      update: data,
      create: { id: "main", ...data },
    })
  }

  async appendHistory(entry: LicenseHistoryEntry): Promise<void> {
    const db = await getPrisma()
    // la nueva pasa a ser la actual; las anteriores dejan de serlo
    await db.licenseHistory.updateMany({ where: { current: true }, data: { current: false } })
    await db.licenseHistory.create({
      data: {
        licenseId: entry.licenseId,
        customerName: entry.customerName,
        plan: entry.plan,
        durationDays: entry.durationDays,
        issuedAt: new Date(entry.issuedAt),
        startsAt: new Date(entry.startsAt),
        expiresAt: new Date(entry.expiresAt),
        installationId: entry.installationId,
        diskId: entry.diskId,
        activatedAt: new Date(entry.activatedAt),
        activatedBy: entry.activatedBy,
        current: entry.current,
      },
    })
  }

  async listHistory(): Promise<LicenseHistoryEntry[]> {
    const db = await getPrisma()
    const rows = (await db.licenseHistory.findMany({
      orderBy: { activatedAt: "desc" },
      take: 50,
    })) as PrismaLicenseHistoryRow[]
    return rows.map((r) => ({
      licenseId: r.licenseId,
      customerName: r.customerName,
      plan: r.plan as LicenseHistoryEntry["plan"],
      durationDays: r.durationDays,
      issuedAt: r.issuedAt.getTime(),
      startsAt: r.startsAt.getTime(),
      expiresAt: r.expiresAt.getTime(),
      installationId: r.installationId,
      diskId: r.diskId,
      activatedAt: r.activatedAt.getTime(),
      activatedBy: r.activatedBy,
      current: r.current,
    }))
  }

  async findHistoryByLicenseId(licenseId: string): Promise<LicenseHistoryEntry | null> {
    const db = await getPrisma()
    const row = (await db.licenseHistory.findFirst({ where: { licenseId } })) as PrismaLicenseHistoryRow | null
    if (!row) return null
    return {
      licenseId: row.licenseId,
      customerName: row.customerName,
      plan: row.plan as LicenseHistoryEntry["plan"],
      durationDays: row.durationDays,
      issuedAt: row.issuedAt.getTime(),
      startsAt: row.startsAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      installationId: row.installationId,
      diskId: row.diskId,
      activatedAt: row.activatedAt.getTime(),
      activatedBy: row.activatedBy,
      current: row.current,
    }
  }
}

/** Almacén en memoria (tests). */
export class MemoryLicenseStore implements LicenseStore {
  record: LicenseRecord | null = null
  history: LicenseHistoryEntry[] = []

  async getLicenseRecord(): Promise<LicenseRecord | null> {
    return this.record
  }
  async saveLicenseRecord(record: LicenseRecord): Promise<void> {
    this.record = record
  }
  async appendHistory(entry: LicenseHistoryEntry): Promise<void> {
    this.history = this.history.map((h) => ({ ...h, current: false }))
    this.history.unshift(entry)
  }
  async listHistory(): Promise<LicenseHistoryEntry[]> {
    return this.history
  }
  async findHistoryByLicenseId(licenseId: string): Promise<LicenseHistoryEntry | null> {
    return this.history.find((h) => h.licenseId === licenseId) ?? null
  }
}
