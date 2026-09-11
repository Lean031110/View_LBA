package com.viewlba.licensegen.core

/** Constantes y validación de payloads (espejo de types.ts del servidor). */
object Specs {
    const val LICENSE_SCHEMA_VERSION = 2
    const val REQUEST_SCHEMA_VERSION = 2
    const val PRODUCT = "ViewLBA-Server"

    const val MAX_CUSTOM_DURATION_DAYS = 3650
    const val REQUEST_CODE_MAX_AGE_DAYS = 15
    const val REQUEST_CUSTOMER_NAME_MIN = 2
    const val REQUEST_CUSTOMER_NAME_MAX = 100

    const val DAY_MS = 24L * 60L * 60L * 1000L

    val LICENSE_ID_RE = Regex("^VLBA-[0-9a-fA-F]{12}$")
    val INSTALLATION_ID_RE = Regex("^VWLB-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$")
    val DISK_ID_RE = Regex("^DSK-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$")
    val NONCE_RE = Regex("^[0-9a-f]{16,64}$")

    /** Features premium completas (las firmadas por defecto en cada emisión). */
    val ALL_FEATURES: LinkedHashMap<String, Boolean> = linkedMapOf(
        "display.watermark" to false,
        "screens.multiDisplay" to true,
        "branding.customLogo" to true,
        "themes.custom" to true,
        "users.management" to true,
        "backup.selfService" to true,
        "analytics.advanced" to true,
    )
}

/** Payload decodificado de un código de solicitud VLREQ2. */
data class RequestPayload(
    val schemaVersion: Int,
    val product: String,
    val customerName: String,
    val installationId: String,
    val diskId: String,
    val nonce: String,
    val requestedAt: Long,
    /** SHA-256 hex del código NORMALIZADO (anti-replay del emisor). */
    val requestHash: String,
)

/** Opciones de una emisión (la duración SOLO la decide el administrador). */
data class IssueOptions(
    val plan: Plan,
    val durationDays: Int,
    /** Inicio de vigencia (ms epoch). Default: ahora. */
    val startsAt: Long,
    /** Acción administrativa EXPLÍCITA para acortar una licencia activa. */
    val allowShorten: Boolean = false,
    /** licenseId forzado (tests) — si null se genera uno nuevo único. */
    val licenseId: String? = null,
    /** nonce forzado (tests). */
    val nonce: String? = null,
) {
    enum class Plan(val label: String) {
        MONTHLY("Mensual · 30 días"),
        ANNUAL("Anual · 365 días"),
        CUSTOM("Personalizada");

        val key: String
            get() = when (this) {
                MONTHLY -> "monthly"
                ANNUAL -> "annual"
                CUSTOM -> "custom"
            }
    }
}

/** Registro de licencia emitida (fila de la DB local). */
data class LicenseRecord(
    val id: Long,
    val licenseId: String,
    val customerName: String,
    val plan: String,
    val durationDays: Int,
    val issuedAt: Long,
    val startsAt: Long,
    val expiresAt: Long,
    val installationId: String,
    val diskId: String,
    val requestHash: String?,
    /** Token VLBA2 completo (vive CIFRADO dentro de la DB SQLCipher). */
    val token: String,
    val createdAt: Long,
    val updatedAt: Long,
) {
    /** Estado calculado en caliente. */
    val status: Status
        get() = when {
            System.currentTimeMillis() < startsAt -> Status.FUTURE
            System.currentTimeMillis() < expiresAt -> Status.ACTIVE
            else -> Status.EXPIRED
        }

    enum class Status(val label: String) {
        ACTIVE("Activa"),
        EXPIRED("Vencida"),
        FUTURE("Futura");
    }
}

/** Error de política del emisor (mensajes humanos, sin detalles criptográficos). */
class PolicyException(message: String) : Exception(message)
