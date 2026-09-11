package com.viewlba.licensegen

import com.viewlba.licensegen.codec.TokenCodec
import com.viewlba.licensegen.core.RequestOpener
import com.viewlba.licensegen.crypto.Base32
import com.viewlba.licensegen.crypto.CanonicalJson
import com.viewlba.licensegen.crypto.CryptoBox
import org.bouncycastle.math.ec.rfc7748.X25519
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Casos 1-4 del requisito sobre la apertura de solicitudes (emisor Android):
 * 1 solicitud válida · 2 modificada · 3 expirada · 4 replay (hash estable) +
 * emisor incorrecto (8 clave incorrecta).
 */
class RequestOpenerTest {

    private val requestPriv = CryptoBox.newX25519PrivateKey()
    private val requestPub = CryptoBox.x25519PublicKey(requestPriv)
    private val otherPriv = CryptoBox.newX25519PrivateKey()

    private val now = 1757068800000L
    private val day = 24L * 60 * 60 * 1000

    /** Sella un payload hacia la pública (espejo de sealRequestPayload TS). */
    private fun seal(customerName: String = "Lo D'Leo", requestedAt: Long = now, nonce: String = "0123456789abcdef"): String {
        val payload = linkedMapOf<String, Any>(
            "v" to 2,
            "product" to "ViewLBA-Server",
            "customerName" to customerName,
            "installationId" to "VWLB-0094-6114-A3A4-8905",
            "diskId" to "DSK-A5ED-432A-37DD",
            "nonce" to nonce,
            "requestedAt" to requestedAt,
        )
        val json = CanonicalJson.serialize(payload)
        val ephPriv = CryptoBox.newX25519PrivateKey()
        val ephPub = CryptoBox.x25519PublicKey(ephPriv)
        val shared = ByteArray(32)
        X25519.calculateAgreement(ephPriv, 0, requestPub, 0, shared, 0)
        val key = CryptoBox.hkdfSha256(shared, ephPub, "viewlba-req-v2".toByteArray(), 32)
        val enc = CryptoBox.aesGcmEncrypt(key, json.toByteArray())
        return TokenCodec.encodeRequestString(TokenCodec.buildRequestFrame(ephPub, enc.iv, enc.ciphertext))
    }

    @Test
    fun `1 - solicitud válida abre con payload EXACTO y hash determinista`() {
        val code = seal()
        val opened = RequestOpener.open(code, requestPriv, now)
        assertEquals("Lo D'Leo", opened.customerName)
        assertEquals("VWLB-0094-6114-A3A4-8905", opened.installationId)
        assertEquals("DSK-A5ED-432A-37DD", opened.diskId)
        assertEquals(now, opened.requestedAt)
        assertEquals("0123456789abcdef", opened.nonce)
        // 4: hash estable
        assertEquals(opened.requestHash, RequestOpener.open(code, requestPriv, now + day).requestHash)
    }

    @Test
    fun `1 - el nombre y los IDs viajan CIFRADOS en el código`() {
        val code = seal(customerName = "NegocioSecretoXYZ")
        assertTrue(!code.contains("NegocioSecretoXYZ"))
        assertTrue(!code.contains("VWLB-0094"))
        assertTrue(!code.contains("DSK-A5ED"))
    }

    @Test
    fun `2 - solicitud modificada (1 carácter) → rechazo estructural`() {
        val code = seal()
        val pos = code.length - 3
        val flipped = code.substring(0, pos) + (if (code[pos] == 'A') 'B' else 'A') + code.substring(pos + 1)
        try {
            RequestOpener.open(flipped, requestPriv, now)
            throw AssertionError("debió rechazar la modificación")
        } catch (e: TokenCodec.CodecException) {
            assertTrue(listOf("bad_crc", "bad_frame", "bad_charset").contains(e.code))
        }
    }

    @Test
    fun `2 - ciphertext manipulado → GCM no abre`() {
        // construir trama con ciphertext alterado PERO CRC recalculado:
        // la defensa restante debe ser el tag GCM
        val payload = linkedMapOf<String, Any>(
            "v" to 2, "product" to "ViewLBA-Server", "customerName" to "Lo D'Leo",
            "installationId" to "VWLB-0094-6114-A3A4-8905", "diskId" to "DSK-A5ED-432A-37DD",
            "nonce" to "0123456789abcdef", "requestedAt" to now,
        )
        val ephPriv = CryptoBox.newX25519PrivateKey()
        val ephPub = CryptoBox.x25519PublicKey(ephPriv)
        val shared = ByteArray(32)
        X25519.calculateAgreement(ephPriv, 0, requestPub, 0, shared, 0)
        val key = CryptoBox.hkdfSha256(shared, ephPub, "viewlba-req-v2".toByteArray(), 32)
        val enc = CryptoBox.aesGcmEncrypt(key, CanonicalJson.serialize(payload).toByteArray())
        val tamperedCt = enc.ciphertext.copyOf()
        tamperedCt[0] = (tamperedCt[0].toInt() xor 0x01).toByte()
        val frame = TokenCodec.buildRequestFrame(ephPub, enc.iv, tamperedCt)
        val code = TokenCodec.encodeRequestString(frame)
        try {
            RequestOpener.open(code, requestPriv, now)
            throw AssertionError("el tag GCM debió fallar")
        } catch (e: TokenCodec.CodecException) {
            assertTrue(e.message!!.contains("no se puede abrir"))
        }
    }

    @Test
    fun `3 - solicitud expirada (más de 15 días) → rechazo con mensaje humano`() {
        val old = seal(requestedAt = now - 16 * day)
        try {
            RequestOpener.open(old, requestPriv, now)
            throw AssertionError("debió expirar")
        } catch (e: com.viewlba.licensegen.core.PolicyException) {
            assertTrue(e.message!!.contains("expiró"))
        }
    }

    @Test
    fun `3 - solicitud dentro de la ventana (día 14) → OK`() {
        val code = seal(requestedAt = now - 14 * day)
        assertEquals("Lo D'Leo", RequestOpener.open(code, requestPriv, now).customerName)
    }

    @Test
    fun `3 - solicitud con fecha futura → rechazo`() {
        val future = seal(requestedAt = now + 5 * day)
        try {
            RequestOpener.open(future, requestPriv, now)
            throw AssertionError("debió rechazar fecha futura")
        } catch (e: com.viewlba.licensegen.core.PolicyException) {
            assertTrue(e.message!!.contains("futura"))
        }
    }

    @Test
    fun `4 - hashes distintos entre códigos distintos (nonces distintos)`() {
        val a = RequestOpener.open(seal(nonce = "0011223344556677"), requestPriv, now)
        val b = RequestOpener.open(seal(nonce = "9988776655443322"), requestPriv, now)
        assertTrue(a.requestHash != b.requestHash)
    }

    @Test
    fun `8 - abrir con la clave de OTRO emisor → no se puede abrir`() {
        val code = seal()
        try {
            RequestOpener.open(code, otherPriv, now)
            throw AssertionError("debió fallar con clave ajena")
        } catch (e: TokenCodec.CodecException) {
            assertTrue(e.message!!.contains("no se puede abrir"))
        }
    }

    @Test
    fun `14 - código vacío  o  prefijo token → rechazo`() {
        try {
            RequestOpener.open("", requestPriv, now)
            throw AssertionError("debió rechazar vacío")
        } catch (e: TokenCodec.CodecException) { assertTrue(e.code == "too_short") }

        try {
            RequestOpener.open("VLBA2-AAAA", requestPriv, now)
            throw AssertionError("debió rechazar prefijo de token")
        } catch (e: TokenCodec.CodecException) { assertTrue(e.code == "bad_prefix") }
    }

    @Test
    fun `15 - código truncado → too_short o estructura`() {
        val code = seal()
        try {
            RequestOpener.open(code.substring(0, 60), requestPriv, now)
            throw AssertionError("debió rechazar truncado")
        } catch (_: TokenCodec.CodecException) { }
    }

    @Test
    fun `16 - código excesivo → too_long`() {
        val code = seal() + "A".repeat(2100)
        try {
            RequestOpener.open(code, requestPriv, now)
            throw AssertionError("debió rechazar longitud")
        } catch (e: TokenCodec.CodecException) {
            assertEquals("too_long", e.code)
        }
    }

    @Test
    fun `17 - código de versión futura → bad_version`() {
        val code = seal()
        val bin = Base32.decodeStrict(code.removePrefix("VLREQ2-").replace("-", ""))!!
        val future = bin.copyOf()
        future[3] = 0x07
        try {
            TokenCodec.parseRequestFrame(future)
            throw AssertionError("debió rechazar versión futura")
        } catch (e: TokenCodec.CodecException) {
            assertEquals("bad_version", e.code)
        }
    }

    @Test
    fun `tolerancia WhatsApp - saltos de línea y espacios`() {
        val code = seal()
        val wrapped = code.chunked(24).joinToString("\n")
        assertEquals("Lo D'Leo", RequestOpener.open(wrapped, requestPriv, now).customerName)
    }
}
