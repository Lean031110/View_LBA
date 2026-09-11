package com.viewlba.licensegen.codec

import com.viewlba.licensegen.crypto.Base32
import com.viewlba.licensegen.crypto.Crc32

/**
 * Tramas binarias y formato externo de tokens VLBA2 / códigos VLREQ2.
 * Espejo EXACTO de src/lib/licensing/codec.ts.
 *
 * TOKEN VLBA2:  "VT2" | 0x02 | payloadLen(2BE) | payload JSON | firma(64) | CRC32(4BE)
 * CÓDIGO VR2:   "VR2" | 0x02 | ephPub(32) | iv(12) | ctLen(2BE) | ct+tag | CRC32(4BE)
 */
object TokenCodec {

    const val TOKEN_PREFIX = "VLBA2"
    const val REQUEST_PREFIX = "VLREQ2"
    const val FRAME_VERSION = 0x02

    const val TOKEN_MIN_LENGTH = 200
    const val TOKEN_MAX_LENGTH = 4096
    const val REQUEST_CODE_MIN_LENGTH = 120
    const val REQUEST_CODE_MAX_LENGTH = 2048
    const val TOKEN_PAYLOAD_MAX_BYTES = 3072

    /** Error estructural con código (paralelo a TokenDecodeError del server). */
    class CodecException(val code: String, message: String) : Exception(message)

    // ------------------------------------------------------------------
    // Normalización de entrada (tolerante a WhatsApp)
    // ------------------------------------------------------------------

    data class Normalized(val prefix: String, val body: String)

    /**
     * Elimina espacios/tab/newline/zero-width y TODOS los guiones (inclusive
     * tipográficos), convierte a MAYÚSCULAS y exige prefijo + cuerpo.
     */
    fun normalizeInput(input: String): Normalized? {
        val cleaned = input
            .replace(Regex("[\\s\\u00a0\\u200b\\ufeff]"), "")
            .replace(Regex("[-\\u2010-\\u2015\\u2212\\u2213]"), "")
            .uppercase()
        val m = Regex("^(VLBA2|VLREQ2)(.+)$").find(cleaned) ?: return null
        return Normalized(m.groupValues[1], m.groupValues[2])
    }

    /** Formato externo con guiones: prefix-XXXX-XXXX-… */
    fun formatWithDashes(prefix: String, body: String): String {
        val sb = StringBuilder(prefix).append('-')
        var i = 0
        while (i < body.length) {
            if (i > 0) sb.append('-')
            sb.append(body.substring(i, minOf(i + 4, body.length)))
            i += 4
        }
        return sb.toString()
    }

    // ------------------------------------------------------------------
    // Trama del token
    // ------------------------------------------------------------------

    fun buildTokenFrame(payload: ByteArray, signature: ByteArray): ByteArray {
        require(payload.size <= 0xffff) { "Payload demasiado grande" }
        require(signature.size == 64) { "La firma Ed25519 debe ser de 64 bytes" }
        val out = ByteArray(6 + payload.size + 64 + 4)
        out[0] = 'V'.code.toByte(); out[1] = 'T'.code.toByte(); out[2] = '2'.code.toByte()
        out[3] = FRAME_VERSION.toByte()
        out[4] = ((payload.size ushr 8) and 0xff).toByte()
        out[5] = (payload.size and 0xff).toByte()
        payload.copyInto(out, 6)
        signature.copyInto(out, 6 + payload.size)
        writeCrc(out, 6 + payload.size + 64)
        return out
    }

    data class TokenFrame(val payloadBytes: ByteArray, val signature: ByteArray)

    fun parseTokenFrame(frame: ByteArray): TokenFrame {
        if (frame.size < 6 + 1 + 64 + 4) throw CodecException("bad_frame", "Trama del token incompleta")
        if (frame[0] != 'V'.code.toByte() || frame[1] != 'T'.code.toByte() || frame[2] != '2'.code.toByte()) {
            throw CodecException("bad_frame", "La trama no corresponde a un token ViewLBA")
        }
        if (frame[3] != FRAME_VERSION.toByte()) {
            throw CodecException(
                "bad_version",
                if (frame[3] > FRAME_VERSION) "El token pertenece a una versión futura no soportada"
                else "Versión de token no soportada"
            )
        }
        val payloadLen = ((frame[4].toInt() and 0xff) shl 8) or (frame[5].toInt() and 0xff)
        if (payloadLen == 0) throw CodecException("bad_frame", "Token sin payload")
        val expected = 6 + payloadLen + 64 + 4
        if (frame.size != expected) throw CodecException("bad_frame", "Longitud del token inconsistente (truncado o alterado)")
        val crcStart = 6 + payloadLen + 64
        if (Crc32.of(frame, 0, crcStart) != readCrc(frame, crcStart)) {
            throw CodecException("bad_crc", "El token está alterado o truncado (checksum incorrecto)")
        }
        return TokenFrame(
            frame.copyOfRange(6, 6 + payloadLen),
            frame.copyOfRange(6 + payloadLen, 6 + payloadLen + 64)
        )
    }

    // ------------------------------------------------------------------
    // Trama del código de solicitud
    // ------------------------------------------------------------------

    fun buildRequestFrame(ephemeralPub: ByteArray, iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(ephemeralPub.size == 32) { "Clave efímera inválida" }
        require(iv.size == 12) { "IV inválido" }
        require(ciphertext.size <= 0xffff) { "Ciphertext demasiado grande" }
        val out = ByteArray(50 + ciphertext.size + 4)
        out[0] = 'V'.code.toByte(); out[1] = 'R'.code.toByte(); out[2] = '2'.code.toByte()
        out[3] = FRAME_VERSION.toByte()
        ephemeralPub.copyInto(out, 4)
        iv.copyInto(out, 36)
        out[48] = ((ciphertext.size ushr 8) and 0xff).toByte()
        out[49] = (ciphertext.size and 0xff).toByte()
        ciphertext.copyInto(out, 50)
        writeCrc(out, 50 + ciphertext.size)
        return out
    }

    data class RequestFrame(val ephemeralPub: ByteArray, val iv: ByteArray, val ciphertext: ByteArray)

    fun parseRequestFrame(frame: ByteArray): RequestFrame {
        if (frame.size < 50 + 16 + 4) throw CodecException("bad_frame", "Trama del código incompleta")
        if (frame[0] != 'V'.code.toByte() || frame[1] != 'R'.code.toByte() || frame[2] != '2'.code.toByte()) {
            throw CodecException("bad_frame", "La trama no corresponde a un código de solicitud ViewLBA")
        }
        if (frame[3] != FRAME_VERSION.toByte()) {
            throw CodecException(
                "bad_version",
                if (frame[3] > FRAME_VERSION) "El código pertenece a una versión futura no soportada"
                else "Versión de código no soportada"
            )
        }
        val ctLen = ((frame[48].toInt() and 0xff) shl 8) or (frame[49].toInt() and 0xff)
        if (ctLen < 16) throw CodecException("bad_frame", "Ciphertext del código inválido")
        val expected = 50 + ctLen + 4
        if (frame.size != expected) throw CodecException("bad_frame", "Longitud del código inconsistente (truncado o alterado)")
        val crcStart = 50 + ctLen
        if (Crc32.of(frame, 0, crcStart) != readCrc(frame, crcStart)) {
            throw CodecException("bad_crc", "El código de solicitud está alterado o truncado")
        }
        return RequestFrame(
            frame.copyOfRange(4, 36),
            frame.copyOfRange(36, 48),
            frame.copyOfRange(50, 50 + ctLen)
        )
    }

    // ------------------------------------------------------------------
    // Encode/decode de strings (Base32 + guiones)
    // ------------------------------------------------------------------

    /** Trama → "VLBA2-XXXX-…" */
    fun encodeTokenString(frame: ByteArray): String = formatWithDashes(TOKEN_PREFIX, Base32.encode(frame))

    /** Trama → "VLREQ2-XXXX-…" */
    fun encodeRequestString(frame: ByteArray): String = formatWithDashes(REQUEST_PREFIX, Base32.encode(frame))

    /**
     * Decodifica el cuerpo Base32 de un token VLBA2 pegado (ya normalizado).
     * Lanza CodecException ante cualquier anomalía estructural.
     */
    fun decodeTokenBody(normalized: Normalized): ByteArray {
        if (normalized.prefix != TOKEN_PREFIX) throw CodecException("bad_prefix", "El token debe comenzar con VLBA2-")
        val total = normalized.body.length + TOKEN_PREFIX.length
        if (total < TOKEN_MIN_LENGTH) throw CodecException("too_short", "El token está incompleto (truncado)")
        if (total > TOKEN_MAX_LENGTH) throw CodecException("too_long", "El token excede la longitud permitida")
        return Base32.decodeStrict(normalized.body)
            ?: throw CodecException("bad_charset", "El token contiene caracteres no permitidos")
    }

    /** Decodifica el cuerpo Base32 de un código VLREQ2 (ya normalizado). */
    fun decodeRequestBody(normalized: Normalized): ByteArray {
        if (normalized.prefix != REQUEST_PREFIX) throw CodecException("bad_prefix", "El código debe comenzar con VLREQ2-")
        val total = normalized.body.length + REQUEST_PREFIX.length
        if (total < REQUEST_CODE_MIN_LENGTH) throw CodecException("too_short", "El código está incompleto (truncado)")
        if (total > REQUEST_CODE_MAX_LENGTH) throw CodecException("too_long", "El código excede la longitud permitida")
        return Base32.decodeStrict(normalized.body)
            ?: throw CodecException("bad_charset", "El código contiene caracteres no permitidos")
    }

    // ------------------------------------------------------------------
    // helpers CRC
    // ------------------------------------------------------------------

    private fun writeCrc(buf: ByteArray, at: Int) {
        val crc = Crc32.of(buf, 0, at).toInt()
        buf[at] = ((crc ushr 24) and 0xff).toByte()
        buf[at + 1] = ((crc ushr 16) and 0xff).toByte()
        buf[at + 2] = ((crc ushr 8) and 0xff).toByte()
        buf[at + 3] = (crc and 0xff).toByte()
    }

    private fun readCrc(buf: ByteArray, at: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = (v shl 8) or (buf[at + i].toLong() and 0xff)
        return v
    }
}
