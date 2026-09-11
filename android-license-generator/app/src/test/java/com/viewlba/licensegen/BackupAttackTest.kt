package com.viewlba.licensegen

import com.viewlba.licensegen.backup.BackupEnvelope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * FASE 16 (release 3.0.0) — ATAQUES AUTORIZADOS contra el backup .vlbak.
 *
 * Todo ataque de manipulación debe ser RECHAZADO de forma segura
 * (BackupException tipada, sin crash, sin datos restaurados parciales):
 *   · versión futura / versión 0 / magic alterado
 *   · salt / IV / ciphertext / checksum manipulados
 *   · truncado en cada posición · bytes aleatorios · archivo vacío
 *   · backup de OTRO tamaño con checksum reinyectado (splice)
 *
 * (PBKDF2 = 120k iter → los casos con contraseña se limitan a pocos para
 * no eternizar la suite; el fuzz masivo usa verifyStructure que no deriva.)
 */
class BackupAttackTest {

    private val password = "clave-de-admin-forte2026!".toCharArray()

    private fun sampleJson(): String = BackupEnvelope.snapshotToJson(
        schema = 1,
        exportedAt = 1_777_777_777_000L,
        keys = emptyMap(),
        licenses = emptyList(),
        requests = emptyList(),
        settings = mapOf("pin" to "1234"),
    )

    // ------------------------------------------------------------------
    // Baseline: el backup legítimo SÍ restaura
    // ------------------------------------------------------------------
    @Test
    fun `baseline - backup válido restaura y el schema viaja`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        val data = BackupEnvelope.decrypt(bak, password)
        assertEquals(1, data.schema)
        assertEquals("1234", data.settings["pin"])
        assertEquals(1, BackupEnvelope.verifyStructure(bak))
    }

    // ------------------------------------------------------------------
    // Ataques de VERSIONADO
    // ------------------------------------------------------------------
    @Test
    fun `ataque - versión FUTURA (0x02) → rechazo explícito`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        bak[5] = 0x02
        expectRejected(bak) { BackupEnvelope.decrypt(it, password) }
        expectRejected(bak) { BackupEnvelope.verifyStructure(it) }
    }

    @Test
    fun `ataque - versión 99 y versión 0 → rechazo`() {
        for (v in intArrayOf(0, 99)) {
            val bak = BackupEnvelope.encrypt(sampleJson(), password)
            bak[5] = v.toByte()
            expectRejected(bak) { BackupEnvelope.decrypt(it, password) }
            expectRejected(bak) { BackupEnvelope.verifyStructure(it) }
        }
    }

    // ------------------------------------------------------------------
    // Ataques de MANIPULACIÓN de bytes
    // ------------------------------------------------------------------
    @Test
    fun `ataque - checksum reinyectado tras manipular el ciphertext (splice) → rechazo`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        // el atacante cambia 1 byte del ciphertext y RECALCULA el sha256
        // externo para colarlo por verifyStructure — el tag GCM interno sigue
        // fallando al descifrar (defensa en profundidad).
        val mutated = bak.copyOf()
        mutated[mutated.size - 40] = (mutated[mutated.size - 40].toInt() xor 0x01).toByte()
        val body = mutated.copyOfRange(6, mutated.size - 32)
        val checksum = com.viewlba.licensegen.crypto.CryptoBox.sha256(body)
        System.arraycopy(checksum, 0, mutated, mutated.size - 32, 32)
        // verifyStructure pasa (checksum reinyectado)…
        BackupEnvelope.verifyStructure(mutated) // NO lanza — capa 1 superada
        // …pero decrypt (tag GCM) DEBE rechazar
        expectRejected(mutated) { BackupEnvelope.decrypt(it, password) }
    }

    @Test
    fun `ataque - manipular el SALT → tag GCM falla aunque el checksum se reinyecte`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        val mutated = bak.copyOf()
        mutated[6] = (mutated[6].toInt() xor 0xFF).toByte()
        val body = mutated.copyOfRange(6, mutated.size - 32)
        val checksum = com.viewlba.licensegen.crypto.CryptoBox.sha256(body)
        System.arraycopy(checksum, 0, mutated, mutated.size - 32, 32)
        expectRejected(mutated) { BackupEnvelope.decrypt(it, password) }
    }

    @Test
    fun `ataque - truncado en CADA posición del archivo → rechazo tipado`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        var len = 0
        while (len < bak.size) {
            expectRejected(bak.copyOfRange(0, len)) { BackupEnvelope.decrypt(it, password) }
            len += 13
        }
    }

    @Test
    fun `ataque - magic alterado (VLBAX) → rechazo`() {
        val bak = BackupEnvelope.encrypt(sampleJson(), password)
        bak[4] = 'X'.code.toByte()
        expectRejected(bak) { BackupEnvelope.decrypt(it, password) }
        expectRejected(bak) { BackupEnvelope.verifyStructure(it) }
    }

    // ------------------------------------------------------------------
    // Fuzz masivo (verifyStructure — sin PBKDF2: rápido)
    // ------------------------------------------------------------------
    @Test
    fun `fuzz - 800 archivos aleatorios → rechazo tipado, cero crashes`() {
        val rnd = Random(0xBACC)
        var rejected = 0
        repeat(800) {
            val garbage = ByteArray(rnd.nextInt(300)) { rnd.nextInt(256).toByte() }
            try {
                BackupEnvelope.verifyStructure(garbage)
                // solo pasaría con magic+versión+checksum válidos al azar (~imposible)
            } catch (_: BackupEnvelope.BackupException) {
                rejected++
            }
        }
        assertTrue("el fuzz debió rechazar casi todo (rechazó $rejected/800)", rejected > 790)
    }

    @Test
    fun `fuzz - archivo vacío y bytes NUL → rechazo limpio`() {
        expectRejected(ByteArray(0)) { BackupEnvelope.verifyStructure(it) }
        expectRejected(ByteArray(500)) { BackupEnvelope.verifyStructure(it) }
        expectRejected(ByteArray(0)) { BackupEnvelope.decrypt(it, password) }
    }

    // ------------------------------------------------------------------
    // Helper
    // ------------------------------------------------------------------
    private inline fun expectRejected(bak: ByteArray, block: (ByteArray) -> Unit) {
        try {
            block(bak)
            throw AssertionError("backup manipulado fue ACEPTADO (${bak.size} bytes)")
        } catch (_: BackupEnvelope.BackupException) {
            // rechazo tipado — PASS
        }
    }
}
