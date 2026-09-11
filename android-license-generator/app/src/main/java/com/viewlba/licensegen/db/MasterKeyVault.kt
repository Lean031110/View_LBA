package com.viewlba.licensegen.db

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.viewlba.licensegen.crypto.CryptoBox
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Bóveda de la clave maestra de la DB:
 *
 *   masterKey (32B aleatorios, primero uso)
 *     ├─ envoltura A: Android Keystore (AES-256-GCM, setUserAuthenticationRequired
 *     │  = true → biometría/credencial del dispositivo). Hardware-backed
 *     │  cuando el Keystore lo soporta (TEE/StrongBox).
 *     └─ envoltura B: PIN del administrador (PBKDF2-HMAC-SHA256, 150k iter).
 *
 * La masterKey NUNCA se persiste en claro: solo sus dos envolturas cifradas.
 * El desbloqueo usa biometría (envoltura A) o PIN (envoltura B).
 */
class MasterKeyVault(private val context: Context) {

    companion object {
        private const val PREFS = "vlba_vault"
        private const val KEY_ALIAS = "vlba_master_wrap"
        private const val F_WRAP_KEystore = "wrap_keystore" // envoltura A (iv+ct)
        private const val F_WRAP_PIN = "wrap_pin"           // envoltura B (salt+iv+ct)
        private const val F_PIN_SALT = "pin_salt"           // sal aleatoria ESTABLE del verificador
        private const val PIN_HASH = "pin_hash"             // verificador PBKDF2
        private const val F_MK_FINGERPRINT = "mk_fingerprint" // sha256 hex (metadato no secreto)
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------

    /** ¿Ya se creó el vault (primer uso completado)? */
    fun isInitialized(): Boolean = prefs.contains(F_WRAP_KEystore) && prefs.contains(F_WRAP_PIN)

    /** ¿Hay PIN configurado? (siempre true tras init, salvo cambio futuro) */
    fun hasPin(): Boolean = prefs.contains(PIN_HASH)

    /** Huella (sha256 hex) de la masterKey — para verificar consistencia. */
    fun masterKeyFingerprint(): String? = prefs.getString(F_MK_FINGERPRINT, null)

    // ------------------------------------------------------------------
    // Primer uso: crear masterKey + PIN
    // ------------------------------------------------------------------

    /**
     * Inicializa el vault: genera la masterKey y la envuelve con Keystore + PIN.
     * @throws IllegalStateException si ya estaba inicializado.
     */
    fun initialize(pin: String): ByteArray {
        require(isValidPin(pin)) { "El PIN debe tener entre 6 y 16 caracteres" }
        check(!isInitialized()) { "El vault ya está inicializado" }

        val masterKey = CryptoBox.randomBytes(32)

        // Envoltura A: Keystore AES-GCM (requiere biometría para DESCIFRAR)
        ensureKeystoreKey()
        val wrapA = keystoreEncrypt(masterKey)

        // Envoltura B: PIN (PBKDF2)
        val wrapB = pinEncrypt(masterKey, pin)

        prefs.edit()
            .putString(F_WRAP_KEystore, encodeBlob(wrapA))
            .putString(F_WRAP_PIN, encodeBlob(wrapB))
            .putString(PIN_HASH, pinVerifier(pin))
            .putString(F_MK_FINGERPRINT, CryptoBox.sha256Hex(masterKey))
            .commit()

        return masterKey
    }

    // ------------------------------------------------------------------
    // Desbloqueo
    // ------------------------------------------------------------------

    /**
     * Desbloquea con el PIN (envoltura B). Verifica PRIMERO el verificador
     * PBKDF2 (rateo limitado por la UI con backoff).
     * @return masterKey o null (PIN incorrecto).
     */
    fun unlockWithPin(pin: String): ByteArray? {
        val expected = prefs.getString(PIN_HASH, null) ?: return null
        if (!verifyPin(pin, expected)) return null
        val wrapB = decodeBlob(prefs.getString(F_WRAP_PIN, null) ?: return null)
        return pinDecrypt(wrapB, pin)
    }

    /**
     * Prepara el Cipher de Keystore (modo DECRYPT) para BiometricPrompt con
     * CryptoObject. Lanza si no hay envoltura A o el alias fue invalidado
     * (re-enrolamiento biométrico) — en ese caso solo queda PIN + re-wrap.
     */
    fun prepareKeystoreDecryptCipher(): Cipher {
        val wrapA = decodeBlob(prefs.getString(F_WRAP_KEystore, null) ?: error("Vault sin envoltura Keystore"))
        val iv = wrapA.copyOfRange(0, 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, iv))
        return cipher
    }

    /**
     * Completa el desbloqueo biométrico: usa el cipher autenticado para
     * descifrar la envoltura A (el cipher YA fue inicializado con el IV en
     * prepareKeystoreDecryptCipher).
     * @return masterKey o null.
     */
    fun unlockWithKeystoreCipher(cipher: Cipher): ByteArray? {
        return try {
            val wrapA = decodeBlob(prefs.getString(F_WRAP_KEystore, null) ?: return null)
            val ct = wrapA.copyOfRange(12, wrapA.size)
            val plain = cipher.doFinal(ct) ?: return null
            verifyFingerprint(plain)
        } catch (_: Exception) {
            null
        }
    }

    /** Cifra un nuevo valor con el cipher autenticado (re-wrap tras enrolar biometría). */
    fun rewrapWithKeystore(cipher: Cipher, masterKey: ByteArray): Boolean {
        return try {
            val encrypted = cipher.doFinal(masterKey)
            val iv = cipher.iv ?: return false
            prefs.edit().putString(F_WRAP_KEystore, encodeBlob(iv + encrypted)).commit()
            true
        } catch (_: Exception) {
            false
        }
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
            .commit()
        return true
    }

    // ------------------------------------------------------------------
    // PIN: política + verificador PBKDF2
    // ------------------------------------------------------------------

    fun isValidPin(pin: String): Boolean = pin.length in 6..16 && pin.isNotBlank()

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
        val candidate = CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
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
        val key = CryptoBox.pbkdf2Sha256(pin.toCharArray(), salt, 150_000)
        val plain = CryptoBox.aesGcmDecrypt(key, iv, ct) ?: return null
        return verifyFingerprint(plain)
    }

    private fun verifyFingerprint(candidate: ByteArray): ByteArray? {
        val expected = prefs.getString(F_MK_FINGERPRINT, null) ?: return null
        return if (CryptoBox.sha256Hex(candidate) == expected) candidate else null
    }

    // ------------------------------------------------------------------
    // Keystore (envoltura A)
    // ------------------------------------------------------------------

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (ks.getKey(KEY_ALIAS, null) as? SecretKey)
            ?: throw IllegalStateException("Clave Keystore inexistente (invalidada por re-enrolamiento biométrico) — desbloquea con PIN")
    }

    private fun ensureKeystoreKey() {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (ks.containsAlias(KEY_ALIAS)) return
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
        builder.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        builder.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        builder.setKeySize(256)
        builder.setUserAuthenticationRequired(true)
        builder.setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= 31) {
            // clave no utilizable sin dispositivo desbloqueado (API 31+)
            builder.setUnlockedDeviceRequired(true)
        }
        generator.init(builder.build())
        generator.generateKey()
    }

    private fun keystoreEncrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        val ct = cipher.doFinal(plain)
        return cipher.iv + ct
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
