package com.viewlba.licensegen

import com.viewlba.licensegen.codec.TokenCodec
import com.viewlba.licensegen.crypto.Base32
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * FASE 10 (release 3.0.0) — FUZZ determinista de los parsers Kotlin.
 *
 * Regla: NINGUNA entrada adversarial puede crashear la app. Todo rechazo
 * debe ser TIPADO: TokenCodec.CodecException (código estructural) o null.
 * PRNG con semilla fija → reproducible en CI.
 */
class CodecFuzzTest {

    private val rnd = Random(0x564C4241L) // "VLBA"
    private val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    private fun randomBytes(n: Int): ByteArray {
        val b = ByteArray(n)
        rnd.nextBytes(b)
        return b
    }

    private fun randomBase32ish(n: Int): String {
        val sb = StringBuilder()
        repeat(n) { sb.append(B32[rnd.nextInt(32)]) }
        return sb.toString()
    }

    // ---------------------------------------------------------------
    // normalizeInput — basura unicode / formatos imposibles
    // ---------------------------------------------------------------
    @Test
    fun `normalizeInput con basura unicode nunca lanza`() {
        val junk = listOf(
            "", " ", "\n\t\r", "😀-🚀", "vlba2", "VLBA", "VLREQ", "X",
            "-".repeat(100), "\u0000\u0001\u0002", "​" /* zwsp */, "ñññ"
        )
        for (j in junk) {
            val n = TokenCodec.normalizeInput(j) // null o estructura — nunca throw
            if (n != null) {
                assertTrue(n.prefix == "VLBA2" || n.prefix == "VLREQ2")
                assertTrue(n.body.isNotEmpty())
            }
        }
        // formas toleradas del pegado humano
        val ok = TokenCodec.normalizeInput("  vlba2\t-\nabcd  ")
        assertTrue(ok != null && ok.prefix == "VLBA2" && ok.body == "ABCD")
    }

    // ---------------------------------------------------------------
    // parseTokenFrame — bytes aleatorios → SOLO CodecException
    // ---------------------------------------------------------------
    @Test
    fun `parseTokenFrame con 500 tramas aleatorias rechaza tipado`() {
        var typed = 0
        for (i in 0 until 500) {
            val bin = randomBytes(rnd.nextInt(400))
            try {
                TokenCodec.parseTokenFrame(bin)
                // si acepta, la trama era casualmente válida — raro pero legal
            } catch (e: TokenCodec.CodecException) {
                typed++
                assertTrue(e.code.isNotEmpty())
            }
        }
        assertTrue("el fuzz debió rechazar casi todo", typed > 400)
    }

    @Test
    fun `parseRequestFrame con 300 tramas aleatorias rechaza tipado`() {
        var typed = 0
        for (i in 0 until 300) {
            val bin = randomBytes(rnd.nextInt(400))
            try {
                TokenCodec.parseRequestFrame(bin)
            } catch (e: TokenCodec.CodecException) {
                typed++
            }
        }
        assertTrue(typed > 250)
    }

    // ---------------------------------------------------------------
    // Mutación del frame VÁLIDO — 1 byte flip → bad_crc/bad_frame
    // ---------------------------------------------------------------
    @Test
    fun `frame válido con bytes alterados nunca se acepta`() {
        val valid = TokenCodec.buildTokenFrame(randomBytes(120), randomBytes(64))
        val positions = intArrayOf(0, 3, 6, 20, valid.size - 1)
        for (pos in positions) {
            val mutated = valid.copyOf()
            mutated[pos] = (mutated[pos].toInt() xor 0xFF).toByte()
            try {
                TokenCodec.parseTokenFrame(mutated)
                throw AssertionError("frame mutado en $pos fue ACEPTADO")
            } catch (_: TokenCodec.CodecException) {
                // rechazo tipado esperado
            }
        }
    }

    @Test
    fun `truncado en TODAS las posiciones del frame válido rechaza`() {
        val valid = TokenCodec.buildTokenFrame(randomBytes(80), randomBytes(64))
        var len = 0
        while (len < valid.size) {
            try {
                TokenCodec.parseTokenFrame(valid.copyOfRange(0, len))
                if (len < valid.size) throw AssertionError("frame truncado a $len aceptado")
            } catch (_: TokenCodec.CodecException) {
                // esperado
            }
            len += 7
        }
    }

    // ---------------------------------------------------------------
    // decodeTokenBody / decodeRequestBody — cuerpos caóticos
    // ---------------------------------------------------------------
    @Test
    fun `decodeTokenBody con cuerpos caóticos rechaza tipado o null`() {
        val bodies = listOf(
            "", "A", "AAAA", "0O1IL", "ñ".repeat(50), "A".repeat(65_536),
            randomBase32ish(50), randomBase32ish(4100)
        )
        for (b in bodies) {
            try {
                TokenCodec.decodeTokenBody(TokenCodec.Normalized("VLBA2", b))
            } catch (_: TokenCodec.CodecException) {
                // rechazo tipado — correcto
            }
        }
    }

    // ---------------------------------------------------------------
    // Base32.decodeStrict — propiedad de roundtrip + caos
    // ---------------------------------------------------------------
    @Test
    fun `Base32 roundtrip exacto (propiedad) y caos rechazado`() {
        repeat(60) {
            val bytes = randomBytes(rnd.nextInt(300) + 1)
            val enc = Base32.encode(bytes)
            val dec = Base32.decodeStrict(enc)
            assertTrue(dec != null && dec.contentEquals(bytes))
        }
        val chaos = listOf("", "A", "0", "1", "L", "O", "ñ", "😀", "AA=", "AAA=", "\u0000")
        for (c in chaos) {
            assertNull("'$c' no debía decodificar", Base32.decodeStrict(c))
        }
    }

    @Test
    fun `formatWithDashes + encodeTokenString producen prefijo correcto`() {
        val frame = TokenCodec.buildTokenFrame(randomBytes(100), randomBytes(64))
        val token = TokenCodec.encodeTokenString(frame)
        assertTrue(token.startsWith("VLBA2-"))
        val norm = TokenCodec.normalizeInput(token)
        assertTrue(norm != null && norm.prefix == "VLBA2")
        // el roundtrip del normalize recupera los bytes EXACTOS del frame
        val decoded = TokenCodec.decodeTokenBody(norm!!)
        assertTrue(decoded.contentEquals(frame))
    }
}
