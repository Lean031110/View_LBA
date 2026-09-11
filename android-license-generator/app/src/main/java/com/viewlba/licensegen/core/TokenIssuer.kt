package com.viewlba.licensegen.core

import com.viewlba.licensegen.codec.TokenCodec
import com.viewlba.licensegen.crypto.CanonicalJson
import com.viewlba.licensegen.crypto.CryptoBox

/**
 * Emisión de tokens VLBA2 (firma Ed25519 sobre el payload canónico).
 * Espejo de buildLicenseToken del servidor (tests) — en PRODUCCIÓN este es
 * el ÚNICO emisor.
 */
object TokenIssuer {

    /**
     * Construye el payload canónico (Map ordenado por CanonicalJson).
     * Las fechas viajan como enteros ms epoch.
     */
    fun buildPayload(
        licenseId: String,
        customerName: String,
        plan: String,
        durationDays: Int,
        issuedAt: Long,
        startsAt: Long,
        installationId: String,
        diskId: String,
        features: Map<String, Boolean>,
        nonce: String,
    ): LinkedHashMap<String, Any> {
        val payload = linkedMapOf<String, Any>(
            "v" to Specs.LICENSE_SCHEMA_VERSION,
            "licenseId" to licenseId,
            "customerName" to customerName,
            "plan" to plan,
            "durationDays" to durationDays,
            "product" to Specs.PRODUCT,
            "issuedAt" to issuedAt,
            "startsAt" to startsAt,
            "expiresAt" to startsAt + durationDays * Specs.DAY_MS,
            "installationId" to installationId,
            "diskId" to diskId,
            "features" to features,
            "nonce" to nonce,
        )
        return payload
    }

    /**
     * Firma el payload canónico y produce el token VLBA2 completo.
     * Auto-verificación de ida y vuelta (defensa en profundidad): si la
     * firma no verifica con la pública derivada, lanza error.
     */
    fun issue(
        payload: Map<String, Any>,
        ed25519Seed: ByteArray,
    ): String {
        val canonical = CanonicalJson.serialize(payload)
        val payloadBytes = canonical.toByteArray(Charsets.UTF_8)
        require(payloadBytes.size <= TokenCodec.TOKEN_PAYLOAD_MAX_BYTES) { "Payload demasiado grande" }

        val signature = CryptoBox.ed25519Sign(ed25519Seed, payloadBytes)
        // auto-verificación (round-trip con la pública derivada del seed)
        if (!CryptoBox.ed25519Verify(CryptoBox.ed25519PublicKey(ed25519Seed), payloadBytes, signature)) {
            throw IllegalStateException("La firma generada no verifica (inconsistencia criptográfica)")
        }

        val frame = TokenCodec.buildTokenFrame(payloadBytes, signature)
        val token = TokenCodec.encodeTokenString(frame)
        require(token.replace("-", "").length <= TokenCodec.TOKEN_MAX_LENGTH) { "Token resultante demasiado largo" }
        return token
    }
}
