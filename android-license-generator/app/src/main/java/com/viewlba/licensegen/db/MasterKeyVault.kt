package com.viewlba.licensegen.db

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
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
        private const val TAG = "ViewLBA-Vault"
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
        // Un PIN «incorrecto» (o un verifier corrupto) NUNCA debe tirar la
        // app: pbkdf2 puede lanzar (p.ej. Android envuelve RuntimeException
        // de PBEKeySpec en InvalidKeySpecException «Could not generate secret
        // key») — se registra con la causa COMPLETA y se trata como fallo.
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
        // Misma regla que verifyPin: ningún fallo criptográfico puede tirar
        // la app desde un listener de UI.
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

        fun baseSpec(): KeyGenParameterSpec.Builder {
            val b = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
            b.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            b.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            b.setKeySize(256)
            if (Build.VERSION.SDK_INT >= 31) {
                // clave no utilizable sin dispositivo desbloqueado (API 31+)
                b.setUnlockedDeviceRequired(true)
            }
            return b
        }

        try {
            // Preferente: clave ligada a autenticación de usuario
            // (biometría o credencial de bloqueo del dispositivo).
            generator.init(baseSpec().also {
                it.setUserAuthenticationRequired(true)
                it.setInvalidatedByBiometricEnrollment(true)
            }.build())
            generator.generateKey()
        } catch (e: Exception) {
            // Dispositivo SIN biometría inscrita NI credencial de bloqueo
            // (típico: emuladores limpios y equipos sin lector). El
            // AndroidKeyStore rechaza claves con setUserAuthenticationRequired
            // (true) en ese caso: «At least one biometric must be enrolled to
            // create keys requiring user authentication for every use».
            //
            // NOTA: según la capa (KeyStore2/ProviderException) el rechazo
            // llega como IllegalStateException U otra envoltura cuyo
            // .message EMBEDE el toString del original (p.ej.
            // «java.lang.IllegalStateException: At least one biometric…»)
            // → se captura Exception y se FILTRA POR MENSAJE (biometric/
            // fingerprint/enrolled); cualquier otro error se re-lanza.
            //
            // Degradación ELEGANTE (el vault DEBE poder crearse siempre):
            // clave SIN binding de autenticación ni requisito de
            // dispositivo desbloqueado (en un equipo sin biometría NI
            // bloqueo, el dispositivo está siempre «desbloqueado» — el
            // requisito no aporta nada). La clave sigue UID-scoped (solo
            // esta app puede usarla) y TEE/StrongBox-backed cuando el
            // hardware lo soporta. En estos dispositivos la UI nunca
            // ofrece desbloqueo biométrico (BiometricManager
            // .canAuthenticate != SUCCESS) y el acceso queda 100 %
            // protegido por el PIN (envoltura B: PBKDF2 150k +
            // AES-256-GCM).
            val msg = (e.message ?: "").lowercase()
            check("biometric" in msg || "fingerprint" in msg || "enrolled" in msg) {
                "AndroidKeyStore: $e"
            }
            val fallback = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
            fallback.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            fallback.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            fallback.setKeySize(256)
            // Generador NUEVO: evita cualquier estado residual del primer
            // intento fallido en la misma instancia.
            val retry = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            retry.init(fallback.build())
            retry.generateKey()
        }
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
