/**
 * ViewLBA — Sistema de licenciamiento OFFLINE (tipos y constantes).
 *
 * Diseño (ver docs/LICENSE-SYSTEM.md y docs/LICENSE-SECURITY.md):
 *  · Licencia firmada Ed25519 (criptografía asimétrica; la clave PRIVADA
 *    solo vive en el generador de licencias, NUNCA en la app/TV/bundle).
 *  · La app solo verifica con la clave pública incrustada.
 *  · Binding mínimo: deviceId (Installation ID) + diskId (binding del disco
 *    de instalación). installPath se registra pero NO es binding estricto.
 *  · 100% offline: ninguna validación requiere Internet.
 */

/** Versión del esquema de licencia (bump → rechazar versiones futuras). */
export const LICENSE_SCHEMA_VERSION = 1

/** Producto que emite/valida esta licencia. */
export const LICENSE_PRODUCT = "ViewLBA-Server"

/** Duración del trial por instalación (días). */
export const TRIAL_DAYS = 7

/** Duración de cada plan comercial (días). */
export const PLAN_DURATION_DAYS: Record<LicensePlan, number> = {
  monthly: 30,
  annual: 365,
}

/** Precio de referencia de cada plan (USD) — informativo, para docs/README. */
export const PLAN_PRICE_USD: Record<LicensePlan, number> = {
  monthly: 10,
  annual: 100,
}

/** Contacto comercial soportado por el proveedor (aparece en watermark y UI). */
export const CONTACT_PHONE = "52973387"

// ---------------------------------------------------------------------------
// Payload de licencia (todo lo firmado — JAMÁS incluir "signature" aquí)
// ---------------------------------------------------------------------------

export type LicensePlan = "monthly" | "annual"

/** Campos de licencia SIN firma. La firma cubre la forma canónica de esto. */
export interface LicensePayload {
  /** Versión de esquema (LICENSE_SCHEMA_VERSION). */
  schemaVersion: number
  /** Identificador de la licencia: VLBA-XXXXXXXXXXXX (12 hex). */
  licenseId: string
  /** Nombre del cliente. */
  customerName: string
  /** Plan contratado. */
  plan: LicensePlan
  /** Fecha de emisión (ISO 8601, UTC). */
  issuedAt: string
  /** Inicio de vigencia (ISO 8601, UTC). */
  startsAt: string
  /** Fin de vigencia (ISO 8601, UTC). */
  expiresAt: string
  /** Installation ID de la instalación vinculada: VWLB-XXXX-XXXX-XXXX-XXXX. */
  deviceId: string
  /** Disk ID del disco vinculado: DSK-XXXX-XXXX-XXXX. */
  diskId: string
  /** Ruta de instalación normalizada (informativa; NO binding estricto). */
  installPath: string
  /** Producto cubierto por la licencia. */
  product: string
  /** Features habilitadas explícitamente por la licencia. */
  features: Record<string, boolean>
}

/** Licencia firmada tal como viaja en license.json. */
export interface SignedLicense extends LicensePayload {
  /** Firma Ed25519 del payload canónico (base64url, 64 bytes). */
  signature: string
}

// ---------------------------------------------------------------------------
// Identidad de la instalación (hardware + disco)
// ---------------------------------------------------------------------------

export interface InstallationIdentity {
  /** SHA-256 completo del fingerprint de hardware (hash interno completo). */
  deviceIdHash: string
  /** Identificador público de instalación: VWLB-XXXX-XXXX-XXXX-XXXX. */
  installationId: string
  /** Cómo se derivó el fingerprint (calidad del binding). */
  fingerprintMethod: "machine-id" | "composite"
  /** SHA-256 completo del binding del disco. */
  diskIdHash: string
  /** Identificador público del disco: DSK-XXXX-XXXX-XXXX. */
  diskId: string
  /** Etiqueta amigable del disco para UX ("C:" / "/dev/sda2 · ext4"). */
  diskLabel: string
  /** Método con el que se detectó el disco (calidad del binding). */
  diskBindingMethod: string
  /** Ruta de instalación en crudo. */
  installPath: string
  /** Ruta de instalación normalizada (comparaciones). */
  installPathNormalized: string
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

/**
 * Estados globales del sistema de licencias:
 *  · trial      — prueba de 7 días activa (sin licencia comercial)
 *  · active     — licencia válida y vigente
 *  · expired    — licencia comercial vencida
 *  · invalid    — licencia con firma/estructura/producto inválidos
 *  · mismatch   — licencia vinculada a otra instalación/disco
 *  · grace      — vencida dentro de la ventana de gracia (opcional)
 *  · unlicensed — sin licencia comercial y trial agotado (o nunca iniciado)
 */
export type LicenseStatus = "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"

/** Estado del trial tras analizar anclas + reloj. */
export interface TrialResult {
  /** ¿El trial está corriendo ahora? */
  active: boolean
  /** true = trial agotado o congelado por manipulación de reloj. */
  ended: boolean
  /** Días restantes (0 si agotado). */
  daysLeft: number
  /** Fin del trial en ms epoch (trialStartAt + 7 días). */
  endsAt: number
  /** Inicio del trial en ms epoch (null = nunca iniciado). */
  startedAt: number | null
  /** Manipulación de reloj detectada (sticky). */
  clockTampered: boolean
}

/** Resultado de validar una licencia contra la instalación actual. */
export interface LicenseValidationResult {
  /** true únicamente si la licencia es válida, vigente y coincide. */
  valid: boolean
  /** Estado derivado. */
  status: "active" | "grace" | "expired" | "invalid" | "mismatch"
  /** Motivos legables (es-ES). Vacío si valid. */
  reasons: string[]
  /** Detalle adicional SOLO para el admin (nunca se expone público). */
  detail?: {
    expectedInstallationId?: string
    foundInstallationId?: string
    expectedDiskId?: string
    foundDiskId?: string
    installPathWarning?: string
  }
  /** Metadatos seguros de la licencia (post-firma-válida). */
  license?: {
    licenseId: string
    customerName: string
    plan: LicensePlan
    issuedAt: string
    startsAt: string
    expiresAt: string
    deviceId: string
    diskId: string
    installPath: string
    features: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Feature flags (se basan en funciones REALES del producto)
// ---------------------------------------------------------------------------

export type FeatureKey =
  | "display.watermark" // true durante trial/limitado (marca de agua en TV)
  | "screens.multiDisplay" // sección Pantallas: gestión multi-pantalla
  | "branding.customLogo" // sección Logotipo: branding personalizado
  | "themes.custom" // sección Apariencia: temas/colores personalizados
  | "users.management" // sección Usuarios: gestión de usuarios/roles
  | "backup.selfService" // botón de backup manual del Dashboard
  | "analytics.advanced" // Dashboard: métricas avanzadas

export interface FeatureAvailability {
  /** Flags resueltas para el estado actual. */
  flags: Record<FeatureKey, boolean>
  /** true si hay marca de agua visible en la TV. */
  watermark: boolean
  /** Texto de la marca de agua (líneas) — null si no hay watermark. */
  watermarkLines: string[] | null
  /** Motivo del bloqueo (para UI) — null si todo desbloqueado. */
  lockReason: string | null
}

// ---------------------------------------------------------------------------
// Anclas de trial (almacenamiento resistente a borrado casual)
// ---------------------------------------------------------------------------

/** Estado persistido en cada ancla de trial (archivo JSON firmado con HMAC). */
export interface TrialAnchorState {
  v: 1
  /** Hash de hardware al que pertenece esta ancla (anclas ajenas se ignoran). */
  deviceIdHash: string
  /** Inicio del trial (ms epoch) — null si aún no arrancó. */
  trialStartAt: number | null
  /** Marca de agua temporal (ms epoch) — anti rollback de reloj. */
  lastSeenAt: number | null
  /** true si se detectó reloj hacia atrás (sticky). */
  clockTampered: boolean
  /** Último estado de licencia registrado (para audit sin spam). */
  lastLoggedStatus?: string | null
  /** HMAC-SHA256 de integridad del propio ancla. */
  stamp: string
}

/** Ancla fusionada (mínimo inicio / máximo lastSeen / sticky flags). */
export interface MergedTrialState {
  trialStartAt: number | null
  lastSeenAt: number | null
  clockTampered: boolean
  lastLoggedStatus: string | null
  /** Anclas leídas con sello inválido (sospecha de manipulación). */
  integrityWarnings: number
  /** Número de anclas físicas encontradas. */
  anchorsFound: number
}

// ---------------------------------------------------------------------------
// Persistencia en DB (autoridad del servidor)
// ---------------------------------------------------------------------------

/** Registro de licencia importada (DB LicenseState — fila única "main"). */
export interface LicenseRecord {
  license: SignedLicense
  importedAt: string
  importedBy: string | null
}

/** Entrada del historial de licencias importadas (DB LicenseHistory). */
export interface LicenseHistoryEntry {
  licenseId: string
  customerName: string
  plan: LicensePlan
  issuedAt: string
  startsAt: string
  expiresAt: string
  deviceId: string
  diskId: string
  importedAt: string
  /** ¿Sigue siendo la licencia activa actual? */
  current: boolean
}

// ---------------------------------------------------------------------------
// Resultado de importación
// ---------------------------------------------------------------------------

export interface ImportResult {
  ok: boolean
  /** Motivos del rechazo (es-ES) si !ok. */
  reasons: string[]
  /** Resumen cuando ok (para toasts/UI). */
  summary?: {
    licenseId: string
    customerName: string
    plan: LicensePlan
    startsAt: string
    expiresAt: string
    daysLeft: number
  }
}

/** Interfaz de almacenamiento de licencias (Prisma en app; mock en tests). */
export interface LicenseStore {
  getLicenseRecord(): Promise<LicenseRecord | null>
  saveLicenseRecord(record: LicenseRecord): Promise<void>
  appendHistory(entry: LicenseHistoryEntry): Promise<void>
  listHistory(): Promise<LicenseHistoryEntry[]>
}

// ---------------------------------------------------------------------------
// Eventos de auditoría (vocabulario exacto del requisito, sección 22)
// ---------------------------------------------------------------------------

export const LICENSE_AUDIT_EVENTS = [
  "license_imported",
  "license_rejected",
  "license_expired",
  "license_mismatch",
  "trial_started",
  "trial_expired",
  "clock_tampering_detected",
] as const
export type LicenseAuditEvent = (typeof LICENSE_AUDIT_EVENTS)[number]
