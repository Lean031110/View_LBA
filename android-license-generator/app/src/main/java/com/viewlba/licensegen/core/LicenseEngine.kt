package com.viewlba.licensegen.core

import com.viewlba.licensegen.crypto.CryptoBox
import com.viewlba.licensegen.db.Db

/**
 * Motor de emisión: valida la solicitud → aplica políticas → firma →
 * persiste (DB cifrada) → audita. Devuelve el token VLBA2 listo para copiar.
 */
class LicenseEngine(private val db: Db, private val clock: () -> Long = System::currentTimeMillis) {

    /** Interfaz de claves del emisor (inyectada para tests). */
    interface IssuerKeys {
        val ed25519Seed: ByteArray
        val x25519Private: ByteArray
        val ed25519PublicB64: String
        val x25519PublicB64: String
    }

    class IssuerException(message: String) : Exception(message)

    /** Abre un código de solicitud con las claves del emisor. */
    fun openRequest(code: String): RequestPayload {
        val keys = keys() ?: throw IssuerException("Claves del emisor no configuradas — impórtalas o genera unas nuevas en Ajustes")
        return RequestOpener.open(code, keys.x25519Private, clock())
    }

    /**
     * Emite una licencia desde una solicitud ya abierta.
     * Pipeline: validación de opciones → anti-replay → licenseId único →
     * payload → firma → auto-verificación → persistencia → auditoría.
     */
    fun issueFromRequest(request: RequestPayload, opts: IssueOptions): Pair<String, LicenseRecord> {
        val keys = keys() ?: throw IssuerException("Claves del emisor no configuradas")
        LicensePolicy.validateIssueOptions(opts)

        // anti-replay: la solicitud solo puede emitir UNA licencia
        if (db.isRequestProcessed(request.requestHash)) {
            throw PolicyException(
                "Este código de solicitud ya fue usado para emitir una licencia — usa «Renovar» desde el historial para extender la vigencia"
            )
        }

        // anti-downgrade contra licencias activas del mismo equipo
        LicensePolicy.checkDowngrade(
            newExpiresAt = opts.startsAt + opts.durationDays * Specs.DAY_MS,
            activeLicenses = db.activeLicensesFor(request.installationId),
            newLicenseId = "nueva", // aún no existe
            allowShorten = opts.allowShorten,
        )

        val now = clock()
        val licenseId = opts.licenseId ?: LicensePolicy.newUniqueLicenseId(db.licenseIds()) { CryptoBox.randomHex(it) }

        val payload = TokenIssuer.buildPayload(
            licenseId = licenseId,
            customerName = request.customerName,
            plan = opts.plan.key,
            durationDays = opts.durationDays,
            issuedAt = now,
            startsAt = opts.startsAt,
            installationId = request.installationId,
            diskId = request.diskId,
            features = Specs.ALL_FEATURES,
            nonce = opts.nonce ?: CryptoBox.randomHex(16),
        )

        val token = TokenIssuer.issue(payload, keys.ed25519Seed)

        val record = LicenseRecord(
            id = 0,
            licenseId = licenseId,
            customerName = request.customerName,
            plan = opts.plan.key,
            durationDays = opts.durationDays,
            issuedAt = now,
            startsAt = opts.startsAt,
            expiresAt = opts.startsAt + opts.durationDays * Specs.DAY_MS,
            installationId = request.installationId,
            diskId = request.diskId,
            requestHash = request.requestHash,
            token = token,
            createdAt = now,
            updatedAt = now,
        )
        db.insertLicense(record)
        db.markRequestProcessed(request.requestHash, request.requestedAt, request.customerName, licenseId)
        db.audit("license_issued", "${request.customerName} · ${opts.plan.key} · ${opts.durationDays} días · $licenseId")
        return token to record
    }

    /**
     * RENOVACIÓN explícita desde el historial (sin código de solicitud):
     * extiende la vigencia del MISMO cliente/equipo con licenseId NUEVO.
     * Inicio por defecto: max(ahora, vencimiento actual) → nunca acorta.
     */
    fun renewFromRecord(record: LicenseRecord, opts: IssueOptions): Pair<String, LicenseRecord> {
        val keys = keys() ?: throw IssuerException("Claves del emisor no configuradas")
        LicensePolicy.validateIssueOptions(opts)

        LicensePolicy.checkDowngrade(
            newExpiresAt = opts.startsAt + opts.durationDays * Specs.DAY_MS,
            activeLicenses = db.activeLicensesFor(record.installationId),
            newLicenseId = "renovacion",
            allowShorten = opts.allowShorten,
        )

        val now = clock()
        val licenseId = opts.licenseId ?: LicensePolicy.newUniqueLicenseId(db.licenseIds()) { CryptoBox.randomHex(it) }
        val payload = TokenIssuer.buildPayload(
            licenseId = licenseId,
            customerName = record.customerName,
            plan = opts.plan.key,
            durationDays = opts.durationDays,
            issuedAt = now,
            startsAt = opts.startsAt,
            installationId = record.installationId,
            diskId = record.diskId,
            features = Specs.ALL_FEATURES,
            nonce = opts.nonce ?: CryptoBox.randomHex(16),
        )
        val token = TokenIssuer.issue(payload, keys.ed25519Seed)

        val newRecord = LicenseRecord(
            id = 0,
            licenseId = licenseId,
            customerName = record.customerName,
            plan = opts.plan.key,
            durationDays = opts.durationDays,
            issuedAt = now,
            startsAt = opts.startsAt,
            expiresAt = opts.startsAt + opts.durationDays * Specs.DAY_MS,
            installationId = record.installationId,
            diskId = record.diskId,
            requestHash = null,
            token = token,
            createdAt = now,
            updatedAt = now,
        )
        db.insertLicense(newRecord)
        db.audit("license_renewed", "${record.customerName} · ${record.licenseId} → $licenseId · ${opts.durationDays} días")
        return token to newRecord
    }

    private fun keys(): IssuerKeys? {
        val ed = db.getKey("ed25519") ?: return null
        val x = db.getKey("x25519") ?: return null
        return object : IssuerKeys {
            override val ed25519Seed: ByteArray = ed.privateBytes
            override val x25519Private: ByteArray = x.privateBytes
            override val ed25519PublicB64: String = ed.publicB64
            override val x25519PublicB64: String = x.publicB64
        }
    }

    // ------------------------------------------------------------------
    // Importación/generación de claves (Ajustes)
    // ------------------------------------------------------------------

    /** Importa un par de claves base64url (privadas) desde el texto pegado. */
    fun importKeys(ed25519PrivateB64: String, x25519PrivateB64: String) {
        val edSeed = CryptoBox.base64UrlDecodeStrict(ed25519PrivateB64.trim())
            ?: throw IssuerException("La clave Ed25519 no es válida (se esperan 32 bytes en base64url)")
        val xPriv = CryptoBox.base64UrlDecodeStrict(x25519PrivateB64.trim())
            ?: throw IssuerException("La clave X25519 no es válida (se esperan 32 bytes en base64url)")
        if (edSeed.size != 32 || xPriv.size != 32) throw IssuerException("Las claves deben ser de 32 bytes (base64url, 43 caracteres)")

        val edPub = CryptoBox.ed25519PublicKey(edSeed)
        val xPub = CryptoBox.x25519PublicKey(xPriv)
        db.putKey("ed25519", CryptoBox.base64UrlEncode(edPub), edSeed)
        db.putKey("x25519", CryptoBox.base64UrlEncode(xPub), xPriv)
        db.audit("keys_imported", "ed25519 pub=${CryptoBox.base64UrlEncode(edPub)}")
    }

    /** Genera un par de claves NUEVO (rotación) — devuelve las públicas b64url. */
    fun generateKeys(): Pair<String, String> {
        val edSeed = CryptoBox.newEd25519Seed()
        val xPriv = CryptoBox.newX25519PrivateKey()
        val edPub = CryptoBox.ed25519PublicKey(edSeed)
        val xPub = CryptoBox.x25519PublicKey(xPriv)
        db.putKey("ed25519", CryptoBox.base64UrlEncode(edPub), edSeed)
        db.putKey("x25519", CryptoBox.base64UrlEncode(xPub), xPriv)
        db.audit("keys_generated", "rotación de claves del emisor")
        return CryptoBox.base64UrlEncode(edPub) to CryptoBox.base64UrlEncode(xPub)
    }

    /** Claves públicas actuales (para mostrar/copiar en Ajustes). */
    fun publicKeys(): Pair<String?, String?> {
        return db.getKey("ed25519")?.publicB64 to db.getKey("x25519")?.publicB64
    }
}
