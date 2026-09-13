package com.viewlba.licensegen.db

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import com.viewlba.licensegen.crypto.CryptoBox
import java.io.File

/**
 * Bóveda de la clave maestra de la DB — versión SIMPLE (v3.2):
 *
 *   masterKey (32B aleatorios, primer uso)
 *     └─ envoltura ÚNICA: PIN del administrador (PBKDF2-HMAC-SHA256 150k +
 *        AES-256-GCM).
 *
 * DECISIÓN DE PRODUCTO (feedback real de dispositivo — Samsung S22 Ultra):
 * la envoltura por Android Keystore con setUserAuthenticationRequired(true)
 * provocaba `UserNotAuthenticatedException` justo en el primer uso (al
 * cifrar la masterKey recién creada SIN BiometricPrompt visible), dejando
 * la app atascada en la primera pantalla en dispositivos REALES con
 * biometría inscrita (los emuladores sin biometría caían en el fallback y
 * por eso el CI pasaba). Además el usuario pidió explícitamente: «sin
 * datos biométricos ni nada, solo un PIN simple configurado desde dentro
 * de la aplicación».
 *
 * La masterKey NUNCA se persiste en claro: solo su envoltura cifrada con
 * el PIN. Migración: los vaults creados por versiones anteriores (≤3.1,
 * con envoltura Keystore A + PIN B) siguen desbloqueándose por el PIN
 * (la envoltura B se conserva intacta); tras un «cambiar PIN» el vault
 * queda re-escrito en el formato nuevo.
 */
class MasterKeyVault(private val context: Context) {

    companion object {
        private const val TAG = "ViewLBA-Vault"
        private const val PREFS = "vlba_vault"
        private const val F_WRAP_PIN = "wrap_pin"           // envoltura (salt+iv+ct)
        private const val F_PIN_SALT = "pin_salt"           // sal aleatoria ESTABLE del verificador
        private const val PIN_HASH = "pin_hash"             // verificador PBKDF2
        private const val F_MK_FINGERPRINT = "mk_fingerprint" // sha256 hex (metadato no secreto)
        private const val F_WRAP_LEGACY = "wrap_keystore"   // envoltura A de versiones ≤3.1 (solo lectura)
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------

    /**
     * ¿Ya se creó el vault (primer uso completado)?
     * Compatibilidad: un vault viejo (con envoltura Keystore legacy) también
     * cuenta como inicializado — se desbloquea por PIN con la envoltura B.
     */
    fun isInitialized(): Boolean = prefs.contains(F_WRAP_PIN) || prefs.contains(F_WRAP_LEGACY)

    /** ¿Hay PIN configurado? (siempre true tras init). */
    fun hasPin(): Boolean = prefs.contains(PIN_HASH)

    /** Huella (sha256 hex) de la masterKey — para verificar consistencia. */
    fun masterKeyFingerprint(): String? = prefs.getString(F_MK_FINGERPRINT, null)

    // ------------------------------------------------------------------
    // Primer uso: crear masterKey + PIN
    // ------------------------------------------------------------------

    /**
     * Inicializa el vault: genera la masterKey y la envuelve con el PIN.
     * @throws IllegalStateException si ya estaba inicializado.
     */
    fun initialize(pin: String): ByteArray {
        require(isValidPin(pin)) { "El PIN debe tener entre 4 y 16 caracteres" }
        check(!isInitialized()) { "El vault ya está inicializado" }

        val masterKey = CryptoBox.randomBytes(32)
        val wrap = pinEncrypt(masterKey, pin)

        prefs.edit()
            .putString(F_WRAP_PIN, encodeBlob(wrap))
            .putString(PIN_HASH, pinVerifier(pin))
            .putString(F_MK_FINGERPRINT, CryptoBox.sha256Hex(masterKey))
            .commit()

        return masterKey
    }

    // ------------------------------------------------------------------
    // Desbloqueo
    // ------------------------------------------------------------------

    /**
     * Desbloquea con el PIN. Verifica PRIMERO el verificador PBKDF2
     * (rateo limitado por la UI con backoff).
     * @return masterKey o null (PIN incorrecto).
     */
    fun unlockWithPin(pin: String): ByteArray? {
        val expected = prefs.getString(PIN_HASH, null) ?: return null
        if (!verifyPin(pin, expected)) return null
        val wrap = decodeBlob(prefs.getString(F_WRAP_PIN, null) ?: return null)
        return pinDecrypt(wrap, pin)
    }

    // ------------------------------------------------------------------
    // Cambio de PIN
    // ------------------------------------------------------------------

    fun changePin(oldPin: String, newPin: String, masterKey: ByteArray): Boolean {
        val expected = prefs.getString(PIN_HASH, null) ?: return false
        if (!verifyPin(oldPin, expected)) return false
        require(isValidPin(newPin)) { "El PIN nuevo no cumple la política" }
        prefs.edit()
            .putString(F_WRAP_PIN, encodeBlob(pinEncrypt(masterKey, newPin)))
            .putString(PIN_HASH, pinVerifier(newPin))
            // re-escritura completa: el vault viejo (con legacy Keystore) queda
            // migrado al formato nuevo solo-PIN en cuanto cambia el PIN.
            .remove(F_WRAP_LEGACY)
            .commit()
        return true
    }

    // ------------------------------------------------------------------
    // PIN: política + verificador PBKDF2
    // ------------------------------------------------------------------

    /** Política SIMPLE pedida por el usuario: 4 a 16 caracteres, no vacío. */
    fun isValidPin(pin: String): Boolean = pin.length in 4..16 && pin.isNotBlank()

    /** Sal aleatoria ESTABLE del verificador de PIN (creada en el primer uso). */
    private fun pinSalt(): ByteArray {
        prefs.getString(F_PIN_SALT, null)?.let { return decodeBlob(it) }
        val salt = CryptoBox.randomBytes(16)
        prefs.edit().putString(F_PIN_SALT, encodeBlob(salt)).commit()
        return salt
    }

    private fun pinVerifier(pin: String): String {
        val salt = pinSalt()
        val key = CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
        return CryptoBox.base64UrlEncode(salt) + ":" + CryptoBox.base64UrlEncode(key)
    }

    private fun verifyPin(pin: String, verifier: String): Boolean {
        val parts = verifier.split(":")
        if (parts.size != 2) return false
        val salt = CryptoBox.base64UrlDecodeStrict(parts[0]) ?: return false
        val expected = CryptoBox.base64UrlDecodeStrict(parts[1]) ?: return false
        // Un PIN «incorrecto» (o un verifier corrupto) NUNCA debe tirar la
        // app: pbkdf2 puede lanzar — se registra con la causa COMPLETA y se
        // trata como fallo.
        val candidate = try {
            CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
        } catch (e: Exception) {
            Log.e(TAG, "verifyPin: pbkdf2 falló (pin=${pin.length} chars, salt=${salt.size} B, expected=${expected.size} B)", e)
            return false
        }
        return constantTimeEquals(expected, candidate)
    }

    private fun pinEncrypt(plain: ByteArray, pin: String): ByteArray {
        val salt = CryptoBox.randomBytes(16)
        val key = CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
        val enc = CryptoBox.aesGcmEncrypt(key, plain)
        return salt + enc.iv + enc.ciphertext
    }

    private fun pinDecrypt(blob: ByteArray, pin: String): ByteArray? {
        if (blob.size < 16 + 12 + 16) return null
        val salt = blob.copyOfRange(0, 16)
        val iv = blob.copyOfRange(16, 28)
        val ct = blob.copyOfRange(28, blob.size)
        // Ningún fallo criptográfico puede tirar la app desde un listener de UI.
        val key = try {
            CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
        } catch (e: Exception) {
            Log.e(TAG, "pinDecrypt: pbkdf2 falló (blob=${blob.size} B, pin=${pin.length} chars)", e)
            return null
        }
        val plain = CryptoBox.aesGcmDecrypt(key, iv, ct) ?: return null
        return verifyFingerprint(plain)
    }

    private fun verifyFingerprint(candidate: ByteArray): ByteArray? {
        val expected = prefs.getString(F_MK_FINGERPRINT, null) ?: return null
        return if (CryptoBox.sha256Hex(candidate) == expected) candidate else null
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private fun encodeBlob(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun decodeBlob(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    /** ¿Queda archivo de DB (para diagnóstico/migraciones)? */
    fun dbFile(): File = Db.file(context)
}
