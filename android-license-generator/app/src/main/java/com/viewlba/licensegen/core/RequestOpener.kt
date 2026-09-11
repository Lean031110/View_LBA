package com.viewlba.licensegen.core

import com.viewlba.licensegen.codec.TokenCodec
import com.viewlba.licensegen.crypto.CryptoBox
import org.json.JSONObject

/**
 * Apertura y validación de códigos de solicitud VLREQ2 (lado emisor).
 * Espejo de src/lib/licensing/request-code.ts (openRequestCode).
 */
object RequestOpener {

    /**
     * Abre un código VLREQ2 pegado por el administrador con la clave PRIVADA
     * X25519 del emisor.
     *
     * Validaciones: prefijo, charset, longitud, trama, CRC, GCM (tag),
     * JSON, esquema (v/producto/nombre/ids/nonce) y ventana de antigüedad.
     * @throws TokenCodec.CodecException (estructural) o PolicyException
     *         (contenido/expiración).
     */
    fun open(code: String, requestPrivateKey: ByteArray, now: Long = System.currentTimeMillis()): RequestPayload {
        val trimmed = code.trim()
        if (trimmed.isEmpty()) throw TokenCodec.CodecException("too_short", "El código está vacío")

        val normalized = TokenCodec.normalizeInput(trimmed)
            ?: throw TokenCodec.CodecException("bad_prefix", "El código debe comenzar con VLREQ2-")

        val bin = TokenCodec.decodeRequestBody(normalized)
        val frame = TokenCodec.parseRequestFrame(bin)

        val json = CryptoBox.openSealedRequest(requestPrivateKey, frame.ephemeralPub, frame.iv, frame.ciphertext)
            ?: throw TokenCodec.CodecException("bad_frame", "El código no se puede abrir (alterado o claves incorrectas)")

        val obj = try {
            JSONObject(json)
        } catch (_: Exception) {
            throw TokenCodec.CodecException("bad_json", "El contenido de la solicitud no es válido")
        }

        if (obj.optInt("v", -1) != Specs.REQUEST_SCHEMA_VERSION) {
            throw PolicyException("Versión de solicitud no soportada")
        }
        if (obj.optString("product") != Specs.PRODUCT) {
            throw PolicyException("La solicitud corresponde a otro producto")
        }
        val customerName = obj.optString("customerName", "")
        if (customerName.trim().length < Specs.REQUEST_CUSTOMER_NAME_MIN || customerName.length > Specs.REQUEST_CUSTOMER_NAME_MAX) {
            throw PolicyException("El nombre del cliente en la solicitud no es válido")
        }
        val installationId = obj.optString("installationId", "")
        if (!Specs.INSTALLATION_ID_RE.matches(installationId)) {
            throw PolicyException("La solicitud no contiene un Installation ID válido")
        }
        val diskId = obj.optString("diskId", "")
        if (!Specs.DISK_ID_RE.matches(diskId)) {
            throw PolicyException("La solicitud no contiene un Disk ID válido")
        }
        val nonce = obj.optString("nonce", "")
        if (!Specs.NONCE_RE.matches(nonce)) {
            throw PolicyException("La solicitud no contiene un nonce válido")
        }
        val requestedAt = obj.optLong("requestedAt", -1)
        if (requestedAt <= 0) {
            throw PolicyException("La solicitud no contiene fecha de generación")
        }
        val ageMs = now - requestedAt
        if (ageMs > Specs.REQUEST_CODE_MAX_AGE_DAYS * Specs.DAY_MS) {
            throw PolicyException(
                "El código de solicitud expiró (máximo ${Specs.REQUEST_CODE_MAX_AGE_DAYS} días de validez) — pide al cliente que genere uno nuevo"
            )
        }
        if (ageMs < -Specs.DAY_MS) {
            throw PolicyException("La solicitud tiene una fecha de generación futura (reloj incorrecto)")
        }

        return RequestPayload(
            schemaVersion = Specs.REQUEST_SCHEMA_VERSION,
            product = Specs.PRODUCT,
            customerName = customerName,
            installationId = installationId,
            diskId = diskId,
            nonce = nonce,
            requestedAt = requestedAt,
            requestHash = CryptoBox.sha256Hex(normalized.prefix + normalized.body),
        )
    }
}
