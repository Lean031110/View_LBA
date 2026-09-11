package com.viewlba.licensegen.db

import android.content.Context
import android.util.Log
import com.viewlba.licensegen.core.LicenseRecord
import com.viewlba.licensegen.core.PolicyException
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File

/**
 * Base de datos local CIFRADA (SQLCipher Community) del generador.
 *
 * La clave maestra (32 bytes aleatorios) la entrega MasterKeyVault tras el
 * desbloqueo (Keystore/biometría o PIN): aquí NUNCA se persiste en claro.
 * Contenido cifrado en reposo:
 *  · material de claves del emisor (Ed25519 seed + X25519 private)
 *  · licencias emitidas (incluye el token VLBA2)
 *  · hashes de solicitudes procesadas (anti-replay)
 *  · ajustes (verificador PIN, autolock) y auditoría
 */
class Db(context: Context, private val masterKey: ByteArray) {

    private val db: SQLiteDatabase

    companion object {
        private const val TAG = "ViewLBA-Db"
        private const val DB_NAME = "licensegen.db"

        init {
            System.loadLibrary("sqlcipher")
        }

        /** Ruta del archivo de DB (para backup/wipe de pruebas). */
        fun file(context: Context): File = context.getDatabasePath(DB_NAME)

        const val SCHEMA_VERSION = 1
    }

    init {
        val dbFile = file(context)
        dbFile.parentFile?.mkdirs()
        db = SQLiteDatabase.openOrCreateDatabase(dbFile, masterKey, null, null, null)
        migrate()
    }

    fun close() {
        try {
            db.close()
        } catch (e: Exception) {
            Log.w(TAG, "close: ${e.message}")
        }
    }

    private fun migrate() {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
            """.trimIndent()
        )
        val current = db.rawQuery("SELECT value FROM meta WHERE key='schema_version'").use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
        if (current == null) {
            db.execSQL("INSERT INTO meta (key, value) VALUES ('schema_version', '$SCHEMA_VERSION')")
            createSchema()
        } else if (current.toInt() != SCHEMA_VERSION) {
            throw IllegalStateException("Versión de DB incompatible ($current vs $SCHEMA_VERSION) — restaura un backup compatible o contacta soporte")
        }
    }

    private fun createSchema() {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS key_material (
              id TEXT PRIMARY KEY,
              public_b64 TEXT NOT NULL,
              private_bytes BLOB NOT NULL,
              created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS licenses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              license_id TEXT NOT NULL UNIQUE,
              customer_name TEXT NOT NULL,
              plan TEXT NOT NULL,
              duration_days INTEGER NOT NULL,
              issued_at INTEGER NOT NULL,
              starts_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              installation_id TEXT NOT NULL,
              disk_id TEXT NOT NULL,
              request_hash TEXT,
              token TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_licenses_installation ON licenses (installation_id)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses (customer_name)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses (expires_at)")
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS requests (
              request_hash TEXT PRIMARY KEY,
              requested_at INTEGER NOT NULL,
              customer_name TEXT NOT NULL,
              license_id TEXT,
              first_seen_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts INTEGER NOT NULL,
              event TEXT NOT NULL,
              details TEXT
            )
            """.trimIndent()
        )
    }

    // ------------------------------------------------------------------
    // Ajustes
    // ------------------------------------------------------------------

    fun getSetting(key: String): String? = db.rawQuery(
        "SELECT value FROM meta WHERE key=?", arrayOf(key)
    ).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    fun putSetting(key: String, value: String) {
        db.execSQL(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            arrayOf(key, value)
        )
    }

    // ------------------------------------------------------------------
    // Material de claves del emisor
    // ------------------------------------------------------------------

    data class KeyMaterial(val publicB64: String, val privateBytes: ByteArray, val createdAt: Long)

    fun getKey(id: String): KeyMaterial? = db.rawQuery(
        "SELECT public_b64, private_bytes, created_at FROM key_material WHERE id=?", arrayOf(id)
    ).use { c ->
        if (!c.moveToFirst()) null
        else KeyMaterial(c.getString(0), c.getBlob(1), c.getLong(2))
    }

    /** Inserta (o reemplaza, en importación/restauración) el material de clave. */
    fun putKey(id: String, publicB64: String, privateBytes: ByteArray) {
        db.beginTransaction()
        try {
            db.execSQL("DELETE FROM key_material WHERE id=?", arrayOf(id))
            db.execSQL(
                "INSERT INTO key_material (id, public_b64, private_bytes, created_at) VALUES (?,?,?,?)",
                arrayOf(id, publicB64, privateBytes, System.currentTimeMillis())
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun hasKeys(): Boolean = getKey("ed25519") != null && getKey("x25519") != null

    // ------------------------------------------------------------------
    // Licencias
    // ------------------------------------------------------------------

    fun insertLicense(record: LicenseRecord) {
        db.execSQL(
            """
            INSERT INTO licenses (
              license_id, customer_name, plan, duration_days, issued_at, starts_at, expires_at,
              installation_id, disk_id, request_hash, token, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """.trimIndent(),
            arrayOf(
                record.licenseId, record.customerName, record.plan, record.durationDays.toString(),
                record.issuedAt.toString(), record.startsAt.toString(), record.expiresAt.toString(),
                record.installationId, record.diskId, record.requestHash, record.token,
                record.createdAt.toString(), record.updatedAt.toString()
            )
        )
    }

    private fun rowToRecord(c: android.database.Cursor): LicenseRecord = LicenseRecord(
        id = c.getLong(0),
        licenseId = c.getString(1),
        customerName = c.getString(2),
        plan = c.getString(3),
        durationDays = c.getInt(4),
        issuedAt = c.getLong(5),
        startsAt = c.getLong(6),
        expiresAt = c.getLong(7),
        installationId = c.getString(8),
        diskId = c.getString(9),
        requestHash = if (c.isNull(10)) null else c.getString(10),
        token = c.getString(11),
        createdAt = c.getLong(12),
        updatedAt = c.getLong(13),
    )

    private val SELECT_COLUMNS =
        "id, license_id, customer_name, plan, duration_days, issued_at, starts_at, expires_at, installation_id, disk_id, request_hash, token, created_at, updated_at"

    fun listLicenses(query: String? = null, statusFilter: StatusFilter = StatusFilter.ALL): List<LicenseRecord> {
        val now = System.currentTimeMillis()
        val args: Array<String>
        val sql: String
        if (!query.isNullOrBlank()) {
            val like = "%" + query.trim().replace("%", "") + "%"
            args = arrayOf(like, like)
            sql = "SELECT $SELECT_COLUMNS FROM licenses WHERE (customer_name LIKE ?1 OR license_id LIKE ?2) ORDER BY created_at DESC"
        } else {
            val where = when (statusFilter) {
                StatusFilter.ALL -> "1=1"
                StatusFilter.ACTIVE -> "starts_at <= $now AND expires_at > $now"
                StatusFilter.EXPIRED -> "expires_at <= $now"
                StatusFilter.FUTURE -> "starts_at > $now"
            }
            args = emptyArray()
            sql = "SELECT $SELECT_COLUMNS FROM licenses WHERE $where ORDER BY created_at DESC"
        }
        return db.rawQuery(sql, args).use(mapRows())
    }

    private fun mapRows(): (android.database.Cursor) -> List<LicenseRecord> = { c ->
        val out = ArrayList<LicenseRecord>()
        while (c.moveToNext()) out.add(rowToRecord(c))
        out
    }

    fun findLicense(licenseId: String): LicenseRecord? = db.rawQuery(
        "SELECT $SELECT_COLUMNS FROM licenses WHERE license_id=?", arrayOf(licenseId)
    ).use { c -> if (c.moveToFirst()) rowToRecord(c) else null }

    fun licenseIds(): Set<String> = db.rawQuery("SELECT license_id FROM licenses", emptyArray()).use { c ->
        val out = HashSet<String>()
        while (c.moveToNext()) out.add(c.getString(0))
        out
    }

    /** Licencias del mismo equipo con vigencia futura (para anti-downgrade). */
    fun activeLicensesFor(installationId: String): List<Pair<Long, String>> {
        val now = System.currentTimeMillis()
        return db.rawQuery(
            "SELECT expires_at, license_id FROM licenses WHERE installation_id=? AND expires_at > ?",
            arrayOf(installationId, now.toString())
        ).use { c ->
            val out = ArrayList<Pair<Long, String>>()
            while (c.moveToNext()) out.add(c.getLong(0) to c.getString(1))
            out
        }
    }

    // ------------------------------------------------------------------
    // Solicitudes procesadas (anti-replay)
    // ------------------------------------------------------------------

    fun isRequestProcessed(requestHash: String): Boolean = db.rawQuery(
        "SELECT 1 FROM requests WHERE request_hash=?", arrayOf(requestHash)
    ).use { it.moveToFirst() }

    fun markRequestProcessed(requestHash: String, requestedAt: Long, customerName: String, licenseId: String?) {
        db.execSQL(
            "INSERT OR IGNORE INTO requests (request_hash, requested_at, customer_name, license_id, first_seen_at) VALUES (?,?,?,?,?)",
            arrayOf(requestHash, requestedAt.toString(), customerName, licenseId, System.currentTimeMillis().toString())
        )
    }

    fun allRequestHashes(): List<Pair<String, Long>> = db.rawQuery(
        "SELECT request_hash, requested_at FROM requests", emptyArray()
    ).use { c ->
        val out = ArrayList<Pair<String, Long>>()
        while (c.moveToNext()) out.add(c.getString(0) to c.getLong(1))
        out
    }

    // ------------------------------------------------------------------
    // Auditoría
    // ------------------------------------------------------------------

    fun audit(event: String, details: String? = null) {
        db.execSQL(
            "INSERT INTO audit (ts, event, details) VALUES (?,?,?)",
            arrayOf(System.currentTimeMillis().toString(), event, details)
        )
    }

    fun listAudit(limit: Int = 200): List<Triple<Long, String, String?>> = db.rawQuery(
        "SELECT ts, event, details FROM audit ORDER BY id DESC LIMIT $limit", emptyArray()
    ).use { c ->
        val out = ArrayList<Triple<Long, String, String?>>()
        while (c.moveToNext()) out.add(Triple(c.getLong(0), c.getString(1), if (c.isNull(2)) null else c.getString(2)))
        out
    }

    // ------------------------------------------------------------------
    // Backup: exportar/importar TODO el contenido
    // ------------------------------------------------------------------

    data class Snapshot(
        val schema: Int,
        val exportedAt: Long,
        val keys: Map<String, KeyMaterial>,
        val licenses: List<LicenseRecord>,
        val requests: List<Triple<String, Long, String>>,
        val settings: Map<String, String>,
    )

    fun snapshot(): Snapshot = Snapshot(
        schema = SCHEMA_VERSION,
        exportedAt = System.currentTimeMillis(),
        keys = listOf("ed25519", "x25519").mapNotNull { id -> getKey(id)?.let { id to it } }.toMap(),
        licenses = listLicenses(),
        requests = allRequestHashes().map { (hash, requestedAt) ->
            Triple(hash, requestedAt, db.rawQuery(
                "SELECT customer_name FROM requests WHERE request_hash=?", arrayOf(hash)
            ).use { c -> if (c.moveToFirst()) c.getString(0) else "" })
        },
        settings = db.rawQuery("SELECT key, value FROM meta WHERE key NOT LIKE 'pin_%' AND key != 'schema_version'", emptyArray()).use { c ->
            val out = HashMap<String, String>()
            while (c.moveToNext()) out[c.getString(0)] = c.getString(1)
            out
        },
    )

    /** Importa un snapshot RESTAURADO (dentro de transacción; NO importa PIN). */
    fun restoreSnapshot(s: Snapshot) {
        if (s.schema != SCHEMA_VERSION) throw PolicyException("Backup con esquema incompatible (${s.schema})")
        db.beginTransaction()
        try {
            db.execSQL("DELETE FROM licenses")
            db.execSQL("DELETE FROM requests")
            db.execSQL("DELETE FROM key_material")
            for ((id, mat) in s.keys) {
                db.execSQL(
                    "INSERT INTO key_material (id, public_b64, private_bytes, created_at) VALUES (?,?,?,?)",
                    arrayOf(id, mat.publicB64, mat.privateBytes, mat.createdAt.toString())
                )
            }
            for (lic in s.licenses) insertLicense(lic)
            for ((hash, requestedAt, customer) in s.requests) {
                db.execSQL(
                    "INSERT OR IGNORE INTO requests (request_hash, requested_at, customer_name, license_id, first_seen_at) VALUES (?,?,?,?,?)",
                    arrayOf(hash, requestedAt.toString(), customer, null, requestedAt.toString())
                )
            }
            for ((k, v) in s.settings) putSetting(k, v)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        audit("backup_restored", "licencias=${s.licenses.size} claves=${s.keys.size}")
    }

    enum class StatusFilter { ALL, ACTIVE, EXPIRED, FUTURE }
}
