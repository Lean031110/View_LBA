package com.viewlba.licensegen.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Criptografía del generador (espejo de src/lib/licensing/crypto.ts):
 *  · Ed25519  — firma de tokens VLBA2 (BouncyCastle rfc8032, uso directo).
 *  · X25519   — apertura de códigos VLREQ2 (ECDH efímero→receptor).
 *  · HKDF     — derivación de la clave de sellado (SHA-256).
 *  · AES-GCM  — cifrado autenticado (javax.crypto).
 *  · PBKDF2   — derivación de claves desde contraseña (backup/PIN).
 *
 * Las claves privadas viajan como bytes crudos (32) y se representan en
 * base64url para importación/exportación (mismo formato que el servidor).
 */
object CryptoBox {

    private val secureRandom = SecureRandom()

    // ------------------------------------------------------------------
    // base64url (claves) — alfabeto A-Z a-z 0-9 - _ sin padding
    // ------------------------------------------------------------------

    private val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun base64UrlEncode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 8 + 5) / 6)
        var bits = 0
        var value = 0
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 6) {
                out.append(B64URL[(value ushr (bits - 6)) and 63])
                bits -= 6
            }
        }
        if (bits > 0) out.append(B64URL[(value shl (6 - bits)) and 63])
        return out.toString()
    }

    /** Decodifica base64url ESTRICTO (43 chars = 32 bytes). null si inválido. */
    fun base64UrlDecodeStrict(s: String): ByteArray? {
        if (s.isEmpty()) return null
        val out = ArrayList<Byte>(s.length * 6 / 8 + 1)
        var bits = 0
        var value = 0
        for (c in s) {
            val v = when (c) {
                in 'A'..'Z' -> c - 'A'
                in 'a'..'z' -> c - 'a' + 26
                in '0'..'9' -> c - '0' + 52
                '-' -> 62
                '_' -> 63
                else -> return null
            }
            value = (value shl 6) or v
            bits += 6
            if (bits >= 8) {
                out.add(((value ushr (bits - 8)) and 0xff).toByte())
                bits -= 8
            }
        }
        return out.toByteArray()
    }

    // ------------------------------------------------------------------
    // Generación de claves
    // ------------------------------------------------------------------

    /** Seed Ed25519 aleatorio (32 bytes). */
    fun newEd25519Seed(): ByteArray = randomBytes(32)

    /** Clave X25519 privada aleatoria (32 bytes). */
    fun newX25519PrivateKey(): ByteArray = randomBytes(32)

    /** Deriva la pública Ed25519 del seed (32 bytes). */
    fun ed25519PublicKey(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "Seed Ed25519 inválida" }
        val pub = ByteArray(32)
        Ed25519.generatePublicKey(seed, 0, pub, 0)
        return pub
    }

    /** Deriva la pública X25519 de la privada (32 bytes). */
    fun x25519PublicKey(privateKey: ByteArray): ByteArray {
        require(privateKey.size == 32) { "Clave X25519 inválida" }
        val pub = ByteArray(32)
        X25519.generatePublicKey(privateKey, 0, pub, 0)
        return pub
    }

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { secureRandom.nextBytes(it) }

    /** Hex aleatorio de n bytes (nonces). */
    fun randomHex(n: Int): String = randomBytes(n).joinToString("") { "%02x".format(it) }

    // ------------------------------------------------------------------
    // Ed25519 — firma y verificación
    // ------------------------------------------------------------------

    /** Firma Ed25519 (64 bytes) de un mensaje con el seed. */
    fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray {
        require(seed.size == 32) { "Seed Ed25519 inválida" }
        val pub = ed25519PublicKey(seed)
        val sig = ByteArray(64)
        Ed25519.sign(seed, 0, pub, 0, message, 0, message.size, sig, 0)
        return sig
    }

    /** Verifica una firma Ed25519 (64 bytes) con la pública cruda. */
    fun ed25519Verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        return Ed25519.verify(signature, 0, publicKey, 0, message, 0, message.size)
    }

    // ------------------------------------------------------------------
    // X25519 + HKDF + AES-256-GCM — apertura de códigos VLREQ2
    // ------------------------------------------------------------------

    const val REQUEST_HKDF_INFO = "viewlba-req-v2"

    /**
     * Abre un sealed box de solicitud:
     * ECDH(requestPriv, ephemeralPub) → HKDF-SHA256(salt=ephemeralPub,
     * info="viewlba-req-v2") → AES-256-GCM.
     * @return el payload JSON en claro o null si el tag GCM no verifica.
     */
    fun openSealedRequest(requestPrivateKey: ByteArray, ephemeralPub: ByteArray, iv: ByteArray, ciphertext: ByteArray): String? {
        if (requestPrivateKey.size != 32 || ephemeralPub.size != 32 || iv.size != 12 || ciphertext.size < 16) return null
        val shared = ByteArray(32)
        if (!X25519.calculateAgreement(requestPrivateKey, 0, ephemeralPub, 0, shared, 0)) return null
        val key = hkdfSha256(shared, ephemeralPub, REQUEST_HKDF_INFO.toByteArray(Charsets.UTF_8), 32)
        val plain = aesGcmDecrypt(key, iv, ciphertext) ?: return null
        return String(plain, Charsets.UTF_8)
    }

    /** HKDF-SHA256 (extract+expand) — espejo de node:crypto hkdfSync. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val gen = HKDFBytesGenerator(SHA256Digest())
        gen.init(HKDFParameters(ikm, salt, info))
        val out = ByteArray(length)
        gen.generateBytes(out, 0, length)
        return out
    }

    // ------------------------------------------------------------------
    // AES-256-GCM (cifrado autenticado)
    // ------------------------------------------------------------------

    class GcmResult(val ciphertext: ByteArray, val iv: ByteArray)

    /** Cifra (IV aleatorio de 12 bytes, tag GCM al final del ciphertext). */
    fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray): GcmResult {
        require(key.size == 32) { "Clave AES-256 requerida" }
        val iv = randomBytes(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(plaintext)
        return GcmResult(ct, iv)
    }

    /** Descifra (tag = últimos 16 bytes). null si el tag no verifica. */
    fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, ciphertextWithTag: ByteArray): ByteArray? {
        if (key.size != 32 || iv.size != 12 || ciphertextWithTag.size < 16) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.doFinal(ciphertextWithTag, 0, ciphertextWithTag.size)
        } catch (_: Exception) {
            null
        }
    }

    // ------------------------------------------------------------------
    // PBKDF2 (backup .vlbak / PIN)
    // ------------------------------------------------------------------

    /** PBKDF2-HMAC-SHA256 → clave de 32 bytes. */
    fun pbkdf2Sha256(password: CharArray, salt: ByteArray, iterations: Int = 120_000): ByteArray {
        val spec = PBEKeySpec(password, salt, iterations, 256)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return factory.generateSecret(spec).encoded
    }

    // ------------------------------------------------------------------
    // Hashes
    // ------------------------------------------------------------------

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Hex(bytes: ByteArray): String = sha256(bytes).joinToString("") { "%02x".format(it) }

    fun sha256Hex(text: String): String = sha256Hex(text.toByteArray(Charsets.UTF_8))
}
