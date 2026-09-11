package com.viewlba.licensegen.backup

import com.viewlba.licensegen.core.LicenseRecord
import com.viewlba.licensegen.crypto.CryptoBox
import org.json.JSONArray
import org.json.JSONObject

/**
 * Backup .vlbak — versión 1:
 *
 *   "VLBAK" (magic, 5 bytes) | version 0x01 | salt(16) | iv(12) |
 *   ciphertext AES-256-GCM (tag incluido) | sha256(salt..ct) (32 bytes)
 *
 *  · Clave: PBKDF2-HMAC-SHA256(contraseña del admin, 120k iter, 256 bits).
 *  · Autenticación: tag GCM + checksum SHA-256 externo (detección de
 *    corrupción/manipulación antes de descifrar).
 *  · Versionado: rechazo explícito de backups futuros.
 *  · El material criptográfico (claves privadas) viaja SOLO cifrado.
 *
 * El formato interno (JSON del plaintext) es portable entre dispositivos y
 * contiene: schema, exportedAt, generator, keys, licenses, requests, settings.
 */
object BackupEnvelope {

    private val MAGIC = byteArrayOf('V'.code.toByte(), 'L'.code.toByte(), 'B'.code.toByte(), 'A'.code.toByte(), 'K'.code.toByte())
    private const val VERSION: Int = 1

    class BackupException(message: String) : Exception(message)

    // ------------------------------------------------------------------
    // Tipos del snapshot (declarados ANTES de BackupData para que el
    // constructor pueda referenciarlos)
    // ------------------------------------------------------------------

    data class DbKey(val publicB64: String, val privateBytes: ByteArray, val createdAt: Long)

    data class DbLicense(
        val licenseId: String, val customerName: String, val plan: String, val durationDays: Int,
        val issuedAt: Long, val startsAt: Long, val expiresAt: Long,
        val installationId: String, val diskId: String, val requestHash: String?,
        val token: String, val createdAt: Long, val updatedAt: Long,
    ) {
        fun toRecord(id: Long) = LicenseRecord(
            id, licenseId, customerName, plan, durationDays, issuedAt, startsAt, expiresAt,
            installationId, diskId, requestHash, token, createdAt, updatedAt
        )
    }

    data class DbRequest(val requestHash: String, val requestedAt: Long, val customerName: String)

    data class BackupData(
        val schema: Int,
        val exportedAt: Long,
        val generator: String,
        val keys: Map<String, DbKey>,
        val licenses: List<DbLicense>,
        val requests: List<DbRequest>,
        val settings: Map<String, String>,
    )

    // ------------------------------------------------------------------
    // Empaquetado (DB Snapshot → JSON)
    // ------------------------------------------------------------------

    fun snapshotToJson(
        schema: Int,
        exportedAt: Long,
        keys: Map<String, DbKey>,
        licenses: List<DbLicense>,
        requests: List<DbRequest>,
        settings: Map<String, String>,
    ): String {
        val root = JSONObject()
        root.put("schema", schema)
        root.put("exportedAt", exportedAt)
        root.put("generator", "android-license-generator/1.0")
        val keysJson = JSONObject()
        for ((id, k) in keys) {
            keysJson.put(id, JSONObject().put("public", k.publicB64).put("private", CryptoBox.base64UrlEncode(k.privateBytes)).put("createdAt", k.createdAt))
        }
        root.put("keys", keysJson)
        val licensesJson = JSONArray()
        for (l in licenses) {
            licensesJson.put(
                JSONObject()
                    .put("licenseId", l.licenseId).put("customerName", l.customerName)
                    .put("plan", l.plan).put("durationDays", l.durationDays)
                    .put("issuedAt", l.issuedAt).put("startsAt", l.startsAt).put("expiresAt", l.expiresAt)
                    .put("installationId", l.installationId).put("diskId", l.diskId)
                    .put("requestHash", l.requestHash ?: JSONObject.NULL)
                    .put("token", l.token)
                    .put("createdAt", l.createdAt).put("updatedAt", l.updatedAt)
            )
        }
        root.put("licenses", licensesJson)
        val requestsJson = JSONArray()
        for (r in requests) {
            requestsJson.put(JSONObject().put("requestHash", r.requestHash).put("requestedAt", r.requestedAt).put("customerName", r.customerName))
        }
        root.put("requests", requestsJson)
        val settingsJson = JSONObject()
        for ((k, v) in settings) settingsJson.put(k, v)
        root.put("settings", settingsJson)
        return root.toString()
    }

    // ------------------------------------------------------------------
    // Cifrado del archivo
    // ------------------------------------------------------------------

    /** Crea el binario .vlbak a partir del JSON del snapshot. */
    fun encrypt(plaintextJson: String, password: CharArray): ByteArray {
        val salt = CryptoBox.randomBytes(16)
        val key = CryptoBox.pbkdf2Sha256(password, salt, 120_000)
        val enc = CryptoBox.aesGcmEncrypt(key, plaintextJson.toByteArray(Charsets.UTF_8))
        val body = salt + enc.iv + enc.ciphertext
        val out = MAGIC + byteArrayOf(VERSION.toByte()) + body + CryptoBox.sha256(body)
        return out
    }

    /**
     * Descifra y parsea un binario .vlbak.
     * @throws BackupException si el magic/versión/checksum/tag no verifican
     *         (backup manipulado, contraseña incorrecta o versión futura).
     */
    fun decrypt(bytes: ByteArray, password: CharArray): BackupData {
        if (bytes.size < 5 + 1 + 16 + 12 + 16 + 32) throw BackupException("El archivo de backup está incompleto (truncado)")
        if (!bytes.copyOfRange(0, 5).contentEquals(MAGIC)) throw BackupException("El archivo no es un backup ViewLBA (.vlbak)")
        val version = bytes[5].toInt() and 0xff
        if (version > VERSION) throw BackupException("El backup pertenece a una versión futura ($version) — actualiza la app")
        if (version != VERSION) throw BackupException("Versión de backup no soportada ($version)")

        val bodyEnd = bytes.size - 32
        val body = bytes.copyOfRange(6, bodyEnd)
        val expectedChecksum = bytes.copyOfRange(bodyEnd, bytes.size)
        if (!CryptoBox.sha256(body).contentEquals(expectedChecksum)) {
            throw BackupException("El backup está alterado o corrupto (checksum incorrecto)")
        }

        val salt = body.copyOfRange(0, 16)
        val iv = body.copyOfRange(16, 28)
        val ct = body.copyOfRange(28, body.size)
        val key = CryptoBox.pbkdf2Sha256(password, salt, 120_000)
        val plain = CryptoBox.aesGcmDecrypt(key, iv, ct)
            ?: throw BackupException("Contraseña incorrecta o backup manipulado (autenticación fallida)")
        return parseJson(String(plain, Charsets.UTF_8))
    }

    /** Verifica integridad SIN descifrar: magic + versión + checksum. */
    fun verifyStructure(bytes: ByteArray): Int {
        if (bytes.size < 5 + 1 + 16 + 12 + 16 + 32) throw BackupException("El archivo de backup está incompleto (truncado)")
        if (!bytes.copyOfRange(0, 5).contentEquals(MAGIC)) throw BackupException("El archivo no es un backup ViewLBA (.vlbak)")
        val version = bytes[5].toInt() and 0xff
        if (version > VERSION) throw BackupException("Backup de versión futura ($version)")
        // MISMO criterio que decrypt: versiones < 1 o no soportadas también se
        // rechazan aquí (antes bastaba con > VERSION y un v0 pasaba la
        // verificación estructural — hallado por BackupAttackTest, FASE 16).
        if (version != VERSION) throw BackupException("Versión de backup no soportada ($version)")
        val bodyEnd = bytes.size - 32
        if (!CryptoBox.sha256(bytes.copyOfRange(6, bodyEnd)).contentEquals(bytes.copyOfRange(bodyEnd, bytes.size))) {
            throw BackupException("El backup está alterado o corrupto (checksum incorrecto)")
        }
        return version
    }

    // ------------------------------------------------------------------
    // Parseo del JSON interno
    // ------------------------------------------------------------------

    fun parseJson(json: String): BackupData {
        val root = try {
            JSONObject(json)
        } catch (_: Exception) {
            throw BackupException("El contenido del backup no es válido")
        }
        val schema = root.optInt("schema", -1)
        if (schema < 1) throw BackupException("Backup sin esquema válido")

        val keys = HashMap<String, DbKey>()
        val keysJson = root.optJSONObject("keys") ?: JSONObject()
        for (id in keysJson.keys()) {
            val k = keysJson.getJSONObject(id)
            val priv = CryptoBox.base64UrlDecodeStrict(k.optString("private"))
                ?: throw BackupException("Clave privada ilegible en el backup ($id)")
            keys[id] = DbKey(k.optString("public"), priv, k.optLong("createdAt", 0))
        }

        val licenses = ArrayList<DbLicense>()
        val larr = root.optJSONArray("licenses") ?: JSONArray()
        for (i in 0 until larr.length()) {
            val l = larr.getJSONObject(i)
            licenses.add(
                DbLicense(
                    licenseId = l.getString("licenseId"),
                    customerName = l.getString("customerName"),
                    plan = l.getString("plan"),
                    durationDays = l.getInt("durationDays"),
                    issuedAt = l.getLong("issuedAt"),
                    startsAt = l.getLong("startsAt"),
                    expiresAt = l.getLong("expiresAt"),
                    installationId = l.getString("installationId"),
                    diskId = l.getString("diskId"),
                    requestHash = if (l.isNull("requestHash")) null else l.optString("requestHash"),
                    token = l.getString("token"),
                    createdAt = l.getLong("createdAt"),
                    updatedAt = l.getLong("updatedAt"),
                )
            )
        }

        val requests = ArrayList<DbRequest>()
        val rarr = root.optJSONArray("requests") ?: JSONArray()
        for (i in 0 until rarr.length()) {
            val r = rarr.getJSONObject(i)
            requests.add(DbRequest(r.getString("requestHash"), r.getLong("requestedAt"), r.optString("customerName", "")))
        }

        val settings = HashMap<String, String>()
        val sJson = root.optJSONObject("settings") ?: JSONObject()
        for (k in sJson.keys()) settings[k] = sJson.optString(k)

        return BackupData(schema, root.optLong("exportedAt", 0), root.optString("generator", ""), keys, licenses, requests, settings)
    }
}
