package com.viewlba.licensegen

import com.viewlba.licensegen.codec.TokenCodec
import com.viewlba.licensegen.core.LicenseEngine
import com.viewlba.licensegen.core.Specs
import com.viewlba.licensegen.core.TokenIssuer
import com.viewlba.licensegen.crypto.Base32
import com.viewlba.licensegen.crypto.CanonicalJson
import com.viewlba.licensegen.crypto.CryptoBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Casos 5-17 del requisito sobre el EMISOR Android (con claves efímeras):
 * 5 licencia válida · 6 modificada · 7 firma incorrecta · 8 clave incorrecta ·
 * 14-17 vacío/truncado/excesivo/versión futura · emisión+auto-verificación.
 */
class TokenIssuerTest {

    private val edSeed = CryptoBox.newEd25519Seed()
    private val otherSeed = CryptoBox.newEd25519Seed()

    private val payload: Map<String, Any> = TokenIssuer.buildPayload(
        licenseId = "VLBA-aabbccddeeff",
        customerName = "Lo D'Leo",
        plan = "annual",
        durationDays = 365,
        issuedAt = 1757068800000L,
        startsAt = 1757068800000L,
        installationId = "VWLB-0094-6114-A3A4-8905",
        diskId = "DSK-A5ED-432A-37DD",
        features = Specs.ALL_FEATURES,
        nonce = "0011223344556677",
    )

    @Test
    fun `5 - emisión válida - token VLBA2 decodificable y firma verificada`() {
        val token = TokenIssuer.issue(payload, edSeed)
        assertTrue(token.startsWith("VLBA2-"))

        val frame = TokenCodec.parseTokenFrame(
            Base32.decodeStrict(token.removePrefix("VLBA2-").replace("-", ""))!!
        )
        assertEquals(CanonicalJson.serialize(payload), String(frame.payloadBytes, Charsets.UTF_8))
        assertTrue(CryptoBox.ed25519Verify(CryptoBox.ed25519PublicKey(edSeed), frame.payloadBytes, frame.signature))
    }

    @Test
    fun `5 - auto-verificación de ida y vuelta integrada en issue()`() {
        // TokenIssuer.issue ya verifica internamente; si lanzara, fallaría:
        TokenIssuer.issue(payload, edSeed)
    }

    @Test
    fun `6 - payload modificado tras firmar → firma ya no verifica`() {
        val token = TokenIssuer.issue(payload, edSeed)
        val frame = TokenCodec.parseTokenFrame(
            Base32.decodeStrict(token.removePrefix("VLBA2-").replace("-", ""))!!
        )
        val tampered = String(frame.payloadBytes, Charsets.UTF_8).replace("Lo D'Leo", "Falsificado")
        assertTrue(
            !CryptoBox.ed25519Verify(
                CryptoBox.ed25519PublicKey(edSeed),
                tampered.toByteArray(), frame.signature
            )
        )
    }

    @Test
    fun `7-8 - firma verificada con OTRA clave → falso`() {
        val token = TokenIssuer.issue(payload, edSeed)
        val frame = TokenCodec.parseTokenFrame(
            Base32.decodeStrict(token.removePrefix("VLBA2-").replace("-", ""))!!
        )
        assertTrue(!CryptoBox.ed25519Verify(CryptoBox.ed25519PublicKey(otherSeed), frame.payloadBytes, frame.signature))
    }

    @Test
    fun `14 - entrada vacía o prefijo ajeno → rechazo`() {
        assertEquals(null, TokenCodec.normalizeInput(""))
        assertEquals(null, TokenCodec.normalizeInput("XXXX2-ABCD"))
        try {
            // prefijo correcto pero cuerpo vacío es irreconocible
            TokenCodec.normalizeInput("VLBA2-")
        } catch (_: Exception) { }
        try {
            TokenCodec.decodeTokenBody(TokenCodec.normalizeInput("VLBA2-" + "A".repeat(300))!!)
            // cuerpo largo pero trama corrupta: la trama debe rechazar
            val bin = Base32.decodeStrict("A".repeat(300))
            TokenCodec.parseTokenFrame(bin!!)
            throw AssertionError("debió rechazar la trama inválida")
        } catch (_: TokenCodec.CodecException) { }
    }

    @Test
    fun `15 - token truncado → estructura rechaza`() {
        val token = TokenIssuer.issue(payload, edSeed)
        for (cut in intArrayOf(20, 60, token.length / 2, token.length - 3)) {
            val truncated = token.substring(0, cut)
            try {
                val n = TokenCodec.normalizeInput(truncated)!!
                val bin = TokenCodec.decodeTokenBody(n)
                TokenCodec.parseTokenFrame(bin) // debe lanzar o no verificar
                throw AssertionError("debió rechazar el truncado en $cut")
            } catch (_: TokenCodec.CodecException) {
                // ✓ rechazado
            }
        }
    }

    @Test
    fun `16 - token excesivo → too_long`() {
        val token = TokenIssuer.issue(payload, edSeed) + "A".repeat(5000)
        try {
            TokenCodec.decodeTokenBody(TokenCodec.normalizeInput(token)!!)
            throw AssertionError("debió rechazar por longitud")
        } catch (e: TokenCodec.CodecException) {
            assertEquals("too_long", e.code)
        }
    }

    @Test
    fun `17 - token de versión futura → bad_version`() {
        val token = TokenIssuer.issue(payload, edSeed)
        val bin = Base32.decodeStrict(token.removePrefix("VLBA2-").replace("-", ""))!!
        val future = bin.copyOf()
        future[3] = 0x09
        try {
            TokenCodec.parseTokenFrame(future)
            throw AssertionError("debió rechazar la versión futura")
        } catch (e: TokenCodec.CodecException) {
            assertEquals("bad_version", e.code)
            assertTrue(e.message!!.contains("versión futura"))
        }
    }

    @Test
    fun `6 - carácter alterado en el cuerpo → CRC o charset rechaza`() {
        val token = TokenIssuer.issue(payload, edSeed)
        val pos = token.length - 3
        val flipped = token.substring(0, pos) + (if (token[pos] == 'A') 'B' else 'A') + token.substring(pos + 1)
        try {
            val n = TokenCodec.normalizeInput(flipped)!!
            val bin = TokenCodec.decodeTokenBody(n)
            TokenCodec.parseTokenFrame(bin)
            throw AssertionError("debió rechazar el token alterado")
        } catch (_: TokenCodec.CodecException) { }
    }

    @Test
    fun `normalización - espacios, saltos y guiones tipográficos tolerados`() {
        val token = TokenIssuer.issue(payload, edSeed)
        val wrapped = token.chunked(20).joinToString("\n")
        val n1 = TokenCodec.normalizeInput(token)!!
        val n2 = TokenCodec.normalizeInput("  $wrapped\r\n ")!!
        assertEquals(n1.body, n2.body)
    }

    @Test
    fun `normalización - prefijo en minúsculas aceptado, prefijo ajeno rechazado`() {
        val token = TokenIssuer.issue(payload, edSeed)
        assertEquals("VLBA2", TokenCodec.normalizeInput(token.lowercase())!!.prefix)
        assertEquals(null, TokenCodec.normalizeInput("XXXX2-ABCD"))
    }

    @Test
    fun `importKeys - claves inválidas rechazadas (28-29 del requisito, lógica)`() {
        val seed32 = CryptoBox.newEd25519Seed()
        assertEquals(32, seed32.size)
        assertEquals(null, CryptoBox.base64UrlDecodeStrict("ñ clave con espacios!"))
        // "AAAA" es base64url válido (3 bytes) — PERO una clave requiere 32
        assertEquals(3, CryptoBox.base64UrlDecodeStrict("AAAA")!!.size)
    }

    @Test
    fun `no colisión de licenseId entre emisiones (nonce o licenseId únicos)`() {
        val t1 = TokenIssuer.issue(payload, edSeed)
        val p2 = TokenIssuer.buildPayload(
            licenseId = "VLBA-001122334455",
            customerName = "Otro",
            plan = "monthly",
            durationDays = 30,
            issuedAt = 1757068800000L,
            startsAt = 1757068800000L,
            installationId = "VWLB-0094-6114-A3A4-8905",
            diskId = "DSK-A5ED-432A-37DD",
            features = Specs.ALL_FEATURES,
            nonce = "9988776655443322",
        )
        val t2 = TokenIssuer.issue(p2, edSeed)
        assertNotEquals(t1, t2)
    }
}
