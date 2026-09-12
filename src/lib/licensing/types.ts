/**
 * ViewLBA — Sistema de licenciamiento por TOKEN copiar/pegar (tipos y constantes).
 *
 * Diseño v2 (ver docs/LICENSE-SYSTEM.md):
 *  · El CLIENTE solo ve dos artefactos:
 *      1. Código de solicitud  VLREQ2-XXXX-XXXX-… (copia y envía por WhatsApp)
 *      2. Token de licencia    VLBA2-XXXX-XXXX-…  (pega y activa)
 *  · El código de solicitud encapsula CIFRADO (X25519 efímero → HKDF →
 *    AES-256-GCM) el customerName, installationId y diskId: viaja sellado
 *    al emisor (app Android privada del administrador).
 *  · El token de licencia viaja FIRMADO (Ed25519) con el binding de equipo
 *    y disco; el servidor SOLO contiene la clave pública de verificación.
 *  · La clave PRIVADA de firma vive EXCLUSIVAMENTE en la app generadora
 *    (android-license-generator), protegida por Android Keystore.
 *  · 100% offline: ninguna validación requiere Internet.
 */

/** Versión del esquema del token de licencia VLBA2 (bump → rechazar futuras). */
export const LICENSE_SCHEMA_VERSION = 2

/** Versión del esquema del código de solicitud VLREQ2. */
export const REQUEST_SCHEMA_VERSION = 2

/** Producto que emite/valida esta licencia. */
export const LICENSE_PRODUCT = "ViewLBA-Server"

/** Duración del trial por instalación (días). */
export const TRIAL_DAYS = 7

/** Duración de cada plan comercial (días); "custom" la define el generador. */
export const PLAN_DURATION_DAYS: Record<Exclude<LicensePlan, "custom">, number> = {
  monthly: 30,
  annual: 365,
}

/** Duración máxima permitida para un plan personalizado (años = 10). */
export const MAX_CUSTOM_DURATION_DAYS = 3650

/** Antigüedad máxima aceptable de un código de solicitud (días). */
export const REQUEST_CODE_MAX_AGE_DAYS = 15

/** Longitud (normalizada, sin guiones/espacios) mínima/máxima del token VLBA2. */
export const TOKEN_MIN_LENGTH = 200
export const TOKEN_MAX_LENGTH = 4096

/** Longitud (normalizada) mínima/máxima del código VLREQ2. */
export const REQUEST_CODE_MIN_LENGTH = 120
export const REQUEST_CODE_MAX_LENGTH = 2048

/** Tamaño máximo del payload JSON firmable del token (bytes). */
export const TOKEN_PAYLOAD_MAX_BYTES = 3072

/** Tamaño máximo del contenido cifrado del código de solicitud (bytes). */
export const REQUEST_CIPHERTEXT_MAX_BYTES = 1024

/** Contacto comercial soportado por el proveedor (aparece en watermark y UI). */
export const CONTACT_PHONE = "52973387"

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

/** La duración SOLO la decide el generador (admin); el cliente nunca la elige. */
export type LicensePlan = "monthly" | "annual" | "custom"

// ---------------------------------------------------------------------------
// Payload del token de licencia (TODO lo firmado — sin "signature" implícito:
// la firma Ed25519 cubre los bytes JSON exactos del payload dentro del frame)
// ---------------------------------------------------------------------------

/** Campos del token VLBA2. Fechas en ms epoch (enteros). */
export interface LicenseTokenPayload {
  /** Versión de esquema (LICENSE_SCHEMA_VERSION). */
  v: number
  /** Identificador de la licencia: VLBA-XXXXXXXXXXXX (12 hex). */
  licenseId: string
  /** Nombre del cliente. */
  customerName: string
  /** Plan contratado (monthly | annual | custom). */
  plan: LicensePlan
  /** Duración exacta en días (1..3650) — la decide el generador. */
  durationDays: number
  /** Producto cubierto por la licencia. */
  product: string
  /** Fecha de emisión (ms epoch). */
  issuedAt: number
  /** Inicio de vigencia (ms epoch). */
  startsAt: number
  /** Fin de vigencia (ms epoch) = startsAt + durationDays días exactos. */
  expiresAt: number
  /** Installation ID vinculada: VWLB-XXXX-XXXX-XXXX-XXXX. */
  installationId: string
  /** Disk ID vinculado: DSK-XXXX-XXXX-XXXX. */
  diskId: string
  /** Features habilitadas explícitamente por la licencia. */
  features: Record<string, boolean>
  /** Nonce único de emisión (hex; anti-replay/colisión de licenseId). */
  nonce: string
}

// ---------------------------------------------------------------------------
// Payload del código de solicitud (viaja CIFRADO, no firmado)
// ---------------------------------------------------------------------------

/** Campos encapsulados dentro del código VLREQ2. */
export interface RequestCodePayload {
  /** Versión de esquema (REQUEST_SCHEMA_VERSION). */
  v: number
  /** Producto que solicita la licencia. */
  product: string
  /** Nombre del negocio/cliente que SOLICITA (lo escribe el cliente). */
  customerName: string
  /** Installation ID de la instalación (generada automáticamente). */
  installationId: string
  /** Disk ID del disco de instalación (generado automáticamente). */
  diskId: string
  /** Nonce único de solicitud (hex; anti-replay del emisor). */
  nonce: string
  /** Momento de generación (ms epoch) — expiración de la solicitud. */
  requestedAt: number
}

// ---------------------------------------------------------------------------
// Identidad de la instalación (hardware + disco) — interna, nunca visible
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
  /** Etiqueta amigable del disco para logs internos ("C:" / "/dev/sda2 · ext4"). */
  diskLabel: string
  /** Método con el que se detectó el disco (calidad del binding). */
  diskBindingMethod: string
  /** Ruta de instalación en crudo (uso interno/telemetry; NO binding). */
  installPath: string
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

/**
 * Estados globales del sistema de licencias:
 *  · trial      — prueba de 7 días activa (sin licencia comercial)
 *  · active     — licencia válida y vigente
 *  · expired    — licencia comercial vencida
 *  · invalid    — token con firma/estructura/producto inválidos
 *  · mismatch   — token vinculado a otra instalación/disco
 *  · grace      — vencida dentro de la ventana de gracia (opcional)
 *  · unlicensed — sin licencia comercial y trial agotado (o nunca iniciado)
 */
export type LicenseStatus = "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"

/** Estado del trial tras analizar anclas + reloj. */
export interface TrialResult {
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

/** Resultado de validar el payload de un token contra la instalación actual. */
export interface LicenseValidationResult {
  /** true únicamente si el token es válido, vigente y coincide con el equipo. */
  valid: boolean
  status: "active" | "grace" | "expired" | "invalid" | "mismatch"
  /** Motivos legables (es-ES). Vacío si valid. */
  reasons: string[]
  /** Metadatos seguros del payload (post-firma-válida). */
  payload?: LicenseTokenPayload
}

// ---------------------------------------------------------------------------
// Feature flags (se basan en funciones REALES del producto)
// ---------------------------------------------------------------------------

export type FeatureKey =
  | "display.watermark"
  | "screens.multiDisplay"
  | "branding.customLogo"
  | "themes.custom"
  | "users.management"
  | "backup.selfService"
  | "analytics.advanced"

/**
 * Features FUTURAS (§18 de la misión 3.1 — «preparar, sin marketplace»):
 * la arquitectura de features del token (Record<string, boolean> validado)
 * ya las ADMITE — un token que las incluya las persiste y se muestran en la
 * sección Licencia. Cuando se implementen de verdad (marketplace, etc.) se
 * suman a FEATURE_KEYS/COMMERCIAL_FEATURES y adquieren gating real.
 */
export const FUTURE_FEATURE_KEYS = [
  "themes.standard",
  "themes.premium",
  "multiDisplay",
  "advancedAnimations",
] as const
export type FutureFeatureKey = (typeof FUTURE_FEATURE_KEYS)[number]

export interface FeatureAvailability {
  flags: Record<FeatureKey, boolean>
  watermark: boolean
  watermarkLines: string[] | null
  lockReason: string | null
}

// ---------------------------------------------------------------------------
// Anclas de trial (almacenamiento resistente a borrado casual)
// ---------------------------------------------------------------------------

/** Estado persistido en cada ancla de trial (archivo JSON firmado con HMAC). */
export interface TrialAnchorState {
  v: 1
  deviceIdHash: string
  trialStartAt: number | null
  lastSeenAt: number | null
  clockTampered: boolean
  lastLoggedStatus?: string | null
  stamp: string
}

/** Ancla fusionada (mínimo inicio / máximo lastSeen / sticky flags). */
export interface MergedTrialState {
  trialStartAt: number | null
  lastSeenAt: number | null
  clockTampered: boolean
  lastLoggedStatus: string | null
  integrityWarnings: number
  anchorsFound: number
}

// ---------------------------------------------------------------------------
// Persistencia en DB (autoridad del servidor)
// ---------------------------------------------------------------------------

/** Registro de licencia activada (DB LicenseState — fila única "main"). */
export interface LicenseRecord {
  /** Token VLBA2 original (normalizado, tal como se pegó). */
  token: string
  /** Payload decodificado y verificado en la activación. */
  payload: LicenseTokenPayload
  /** Momento de activación (ms epoch ISO). */
  activatedAt: string
  activatedBy: string | null
}

/** Entrada del historial de licencias activadas (DB LicenseHistory). */
export interface LicenseHistoryEntry {
  licenseId: string
  customerName: string
  plan: LicensePlan
  durationDays: number
  /** Fechas en ms epoch. */
  issuedAt: number
  startsAt: number
  expiresAt: number
  installationId: string
  diskId: string
  activatedAt: number
  activatedBy: string | null
  current: boolean
}

/** Interfaz de almacenamiento de licencias (Prisma en app; mock en tests). */
export interface LicenseStore {
  getLicenseRecord(): Promise<LicenseRecord | null>
  saveLicenseRecord(record: LicenseRecord): Promise<void>
  appendHistory(entry: LicenseHistoryEntry): Promise<void>
  listHistory(): Promise<LicenseHistoryEntry[]>
  /** Búsqueda por licenseId (control anti-replay/colisión). */
  findHistoryByLicenseId(licenseId: string): Promise<LicenseHistoryEntry | null>
}

// ---------------------------------------------------------------------------
// Resultado de activación (POST /api/license/activate)
// ---------------------------------------------------------------------------

/** Resumen seguro de una licencia activa (SIN datos de binding). */
export interface LicenseSummary {
  licenseId: string
  customerName: string
  plan: LicensePlan
  durationDays: number
  issuedAt: number
  startsAt: number
  expiresAt: number
  daysLeft: number
  features: Record<string, boolean>
}

/** Códigos de rechazo de activación (se mapean a mensajes humanos). */
export type ActivationRejectCode =
  | "empty_token"
  | "bad_charset"
  | "too_short"
  | "too_long"
  | "bad_prefix"
  | "bad_frame"
  | "bad_version"
  | "bad_crc"
  | "bad_json"
  | "bad_schema"
  | "bad_signature"
  | "bad_product"
  | "bad_dates"
  | "not_started"
  | "already_expired"
  | "binding_mismatch"
  | "duplicate_license"
  | "downgrade"

export interface ActivationResult {
  ok: boolean
  /** Código del rechazo si !ok. */
  code?: ActivationRejectCode
  /** Mensivo legible (es-ES) — humano, sin detalles criptográficos. */
  reason?: string
  /** true si el token ya estaba activo (re-activación idempotente). */
  alreadyActive?: boolean
  /** Resumen cuando ok. */
  summary?: LicenseSummary
}

// ---------------------------------------------------------------------------
// Errores de decodificación de tokens/códigos
// ---------------------------------------------------------------------------

/** Error de decodificación con código estructural (nunca expone secretos). */
export class TokenDecodeError extends Error {
  constructor(
    public readonly code: "bad_prefix" | "bad_charset" | "too_short" | "too_long" | "bad_frame" | "bad_version" | "bad_crc" | "bad_json",
    message: string
  ) {
    super(message)
    this.name = "TokenDecodeError"
  }
}

// ---------------------------------------------------------------------------
// Eventos de auditoría
// ---------------------------------------------------------------------------

export const LICENSE_AUDIT_EVENTS = [
  "license_activated",
  "license_rejected",
  "license_expired",
  "license_mismatch",
  "trial_started",
  "trial_expired",
  "clock_tampering_detected",
] as const
export type LicenseAuditEvent = (typeof LICENSE_AUDIT_EVENTS)[number]
