package com.viewlba.licensegen

import com.viewlba.licensegen.backup.BackupEnvelope
import com.viewlba.licensegen.core.Specs
import com.viewlba.licensegen.crypto.CryptoBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Casos 18-20 del requisito (backup válido / alterado / restore) + §11
 * (material de claves SOLO cifrado) y §12 (la clave privada no aparece en
 * claro en el BINARIO del backup… solo tras descifrar con la contraseña).
 */
class BackupEnvelopeTest {

    private fun sampleData(): BackupEnvelope.BackupData {
        val edSeed = CryptoBox.base64UrlDecodeStrict("ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8")!!
        val xPriv = CryptoBox.base64UrlDecodeStrict("_ty6mHZUMhD-3LqYdlQyEP7cuph2VDIQ_ty6mHZUMhA")!!
        return BackupEnvelope.BackupData(
            schema = 1,
            exportedAt = 1757068800000L,
            generator = "test",
            keys = mapOf(
                "ed25519" to BackupEnvelope.DbKey("pubEd", edSeed, 1),
                "x25519" to BackupEnvelope.DbKey("pubX", xPriv, 2),
            ),
            licenses = listOf(
                BackupEnvelope.DbLicense(
                    "VLBA-aaaaaaaaaaaa", "Lo D'Leo", "annual", 365,
                    1757068800000L, 1757068800000L, 1757068800000L + 365 * Specs.DAY_MS,
                    "VWLB-0094-6114-A3A4-8905", "DSK-A5ED-432A-37DD", "reqhash",
                    "VLBA2-TEST-TOKEN", 1757068800000L, 1757068800000L
                )
            ),
            requests = listOf(BackupEnvelope.DbRequest("reqhash", 1757068800000L, "Lo D'Leo")),
            settings = mapOf("last_backup_at" to "1757068800000"),
        )
    }

    private fun sampleJson(): String = BackupEnvelope.snapshotToJson(
        schema = 1,
        exportedAt = 1757068800000L,
        keys = sampleData().keys,
        licenses = sampleData().licenses,
        requests = sampleData().requests,
        settings = mapOf("k" to "v"),
    )

    @Test
    fun `18 - backup válido - roundtrip cifrado + restore parseado EXACTO`() {
        val json = sampleJson()
        val bytes = BackupEnvelope.encrypt(json, "contraseña-segura".toCharArray())

        // el binario NUNCA contiene material en claro
        val binStr = String(bytes, Charsets.ISO_8859_1)
        assertTrue(!binStr.contains("Lo D'Leo"))
        assertTrue(!binStr.contains("VLBA-aaaaaaaaaaaa"))
        assertTrue(!binStr.contains("ASNFZ4mrze8"))

        val restored = BackupEnvelope.decrypt(bytes, "contraseña-segura".toCharArray())
        assertEquals(1, restored.licenses.size)
        assertEquals("Lo D'Leo", restored.licenses[0].customerName)
        assertEquals(2, restored.keys.size)
        assertEquals(1, restored.requests.size)
        assertEquals("reqhash", restored.requests[0].requestHash)
    }

    @Test
    fun `19 - backup alterado (1 byte) → checksum rechaza`() {
        val bytes = BackupEnvelope.encrypt(sampleJson(), "pw".toCharArray())
        val tampered = bytes.copyOf()
        tampered[tampered.size / 2] = (tampered[tampered.size / 2].toInt() xor 0x41).toByte()
        try {
            BackupEnvelope.decrypt(tampered, "pw".toCharArray())
            throw AssertionError("debió rechazar el backup manipulado")
        } catch (e: BackupEnvelope.BackupException) {
            assertTrue(e.message!!.contains("alterado") || e.message!!.contains("corrupto"))
        }
    }

    @Test
    fun `19 - backup truncado → rechazo`() {
        val bytes = BackupEnvelope.encrypt(sampleJson(), "pw".toCharArray())
        try {
            BackupEnvelope.decrypt(bytes.copyOfRange(0, bytes.size - 10), "pw".toCharArray())
            throw AssertionError("debió rechazar el backup truncado")
        } catch (e: BackupEnvelope.BackupException) {
            assertTrue(
                e.message!!.contains("incompleto") || e.message!!.contains("truncado") ||
                    e.message!!.contains("alterado") || e.message!!.contains("corrupto") ||
                    e.message!!.contains("manipulado")
            )
        }
    }

    @Test
    fun `contraseña incorrecta → autenticación falla`() {
        val bytes = BackupEnvelope.encrypt(sampleJson(), "correcta".toCharArray())
        try {
            BackupEnvelope.decrypt(bytes, "incorrecta".toCharArray())
            throw AssertionError("debió fallar la autenticación GCM")
        } catch (e: BackupEnvelope.BackupException) {
            assertTrue(e.message!!.contains("Contraseña incorrecta"))
        }
    }

    @Test
    fun `19 - magic incorrecto → rechazo`() {
        try {
            BackupEnvelope.decrypt(ByteArray(200), "pw".toCharArray())
            throw AssertionError("debió rechazar el archivo ajeno")
        } catch (e: BackupEnvelope.BackupException) { assertTrue(e.message!!.contains(".vlbak")) }
    }

    @Test
    fun `20 - verifyStructure valida sin descifrar`() {
        val bytes = BackupEnvelope.encrypt(sampleJson(), "pw".toCharArray())
        assertEquals(1, BackupEnvelope.verifyStructure(bytes))
        val tampered = bytes.copyOf()
        tampered[20] = (tampered[20].toInt() xor 0x01).toByte()
        try {
            BackupEnvelope.verifyStructure(tampered)
            throw AssertionError("debió detectar la manipulación")
        } catch (_: BackupEnvelope.BackupException) { }
    }

    @Test
    fun `21 - restore reproduce registros operables (LicenseRecord)`() {
        val json = sampleJson()
        val bytes = BackupEnvelope.encrypt(json, "pw".toCharArray())
        val data = BackupEnvelope.decrypt(bytes, "pw".toCharArray())
        val record = data.licenses[0].toRecord(0)
        assertEquals("Lo D'Leo", record.customerName)
        assertEquals(365, record.durationDays)
        assertEquals("VLBA2-TEST-TOKEN", record.token)
    }

    @Test
    fun `determinismo de derivación PBKDF2 (misma contraseña+sal = misma clave)`() {
        val salt = CryptoBox.randomBytes(16)
        val a = CryptoBox.pbkdf2Sha256("hola".toCharArray(), salt, 1000)
        val b = CryptoBox.pbkdf2Sha256("hola".toCharArray(), salt, 1000)
        assertTrue(a.contentEquals(b))
        val c = CryptoBox.pbkdf2Sha256("hola2".toCharArray(), salt, 1000)
        assertTrue(!a.contentEquals(c))
    }
}
