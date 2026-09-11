package com.viewlba.licensegen.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.viewlba.licensegen.R
import com.viewlba.licensegen.backup.BackupEnvelope
import com.viewlba.licensegen.core.IssueOptions
import com.viewlba.licensegen.core.LicenseEngine
import com.viewlba.licensegen.core.LicenseRecord
import com.viewlba.licensegen.core.RequestPayload
import com.viewlba.licensegen.db.Db
import com.viewlba.licensegen.db.MasterKeyVault
import com.viewlba.licensegen.util.Fmt
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * ViewLBA License Generator — app PRIVADA del administrador.
 *
 * Seguridad:
 *  · DB SQLCipher cifrada; master key envuelta por Android Keystore
 *    (biometría) y por PIN (PBKDF2).
 *  · Desbloqueo: biometría (CryptoObject) o PIN.
 *  · Auto-bloqueo al pasar a segundo plano (>60s) y botón de bloqueo.
 *  · Las claves privadas Ed25519/X25519 NUNCA salen en claro: solo dentro
 *    de la DB cifrada o del backup .vlbak (cifrado con contraseña).
 *
 * Flujo: código del cliente → pegar → validar → duración → GENERAR →
 * token copiado → enviarlo por WhatsApp al cliente.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val AUTOLOCK_MS = 60_000L
        private const val REQ_CREATE_BACKUP = 41
        private const val REQ_RESTORE_BACKUP = 42
        private const val REQ_VERIFY_BACKUP = 43
    }

    lateinit var vault: MasterKeyVault
    private var db: Db? = null
    private var engine: LicenseEngine? = null
    private val bg: ExecutorService = Executors.newSingleThreadExecutor()

    private var lastPausedAt = 0L
    private var container: ViewGroup? = null
    private var pendingBackupPassword: String? = null
    private var pendingRestorePassword: String? = null
    private var pendingVerifyPassword: String? = null
    private var renewSource: LicenseRecord? = null

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = MasterKeyVault(this)
        setContentView(R.layout.activity_main)
        container = findViewById(R.id.container)
        if (vault.isInitialized()) showUnlock() else showFirstUse()
    }

    override fun onPause() {
        super.onPause()
        lastPausedAt = System.currentTimeMillis()
    }

    override fun onResume() {
        super.onResume()
        val paused = lastPausedAt
        if (engine != null && paused > 0 && System.currentTimeMillis() - paused > AUTOLOCK_MS) {
            lock()
        }
    }

    override fun onDestroy() {
        db?.close()
        bg.shutdown()
        super.onDestroy()
    }

    fun lock() {
        renewSource = null
        db?.close()
        db = null
        engine = null
        showUnlock()
    }

    private fun openDb(masterKey: ByteArray) {
        db = Db(this, masterKey)
        engine = LicenseEngine(db!!)
    }

    // ------------------------------------------------------------------
    // Navegación
    // ------------------------------------------------------------------

    private fun inflate(layout: Int): View = LayoutInflater.from(this).inflate(layout, container, false)

    private fun swap(view: View) {
        container?.removeAllViews()
        container?.addView(view)
    }

    // ------------------------------------------------------------------
    // Primer uso
    // ------------------------------------------------------------------

    private fun showFirstUse() {
        val v = inflate(R.layout.screen_first_use)
        val pin1 = v.findViewById<EditText>(R.id.pin1)
        val pin2 = v.findViewById<EditText>(R.id.pin2)
        val status = v.findViewById<TextView>(R.id.first_use_status)
        val create = v.findViewById<View>(R.id.btn_create)
        create.setOnClickListener {
            val p1 = pin1.text.toString()
            val p2 = pin2.text.toString()
            if (!vault.isValidPin(p1)) {
                status.text = getString(R.string.pin_policy)
                return@setOnClickListener
            }
            if (p1 != p2) {
                status.text = getString(R.string.pin_mismatch)
                return@setOnClickListener
            }
            try {
                openDb(vault.initialize(p1))
                Toast.makeText(this, R.string.vault_created, Toast.LENGTH_LONG).show()
                showHome()
            } catch (e: Exception) {
                status.text = e.message ?: getString(R.string.generic_error)
            }
        }
        pin2.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { create.performClick(); true } else false
        }
        swap(v)
    }

    // ------------------------------------------------------------------
    // Desbloqueo (biometría o PIN)
    // ------------------------------------------------------------------

    private fun showUnlock() {
        val v = inflate(R.layout.screen_unlock)
        val pin = v.findViewById<EditText>(R.id.unlock_pin)
        val status = v.findViewById<TextView>(R.id.unlock_status)
        val unlock = v.findViewById<View>(R.id.btn_unlock)
        val bioBtn = v.findViewById<View>(R.id.btn_biometric)

        val canBiometric = BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) ==
            BiometricManager.BIOMETRIC_SUCCESS
        bioBtn.visibility = if (canBiometric) View.VISIBLE else View.GONE
        bioBtn.setOnClickListener { tryBiometricUnlock() }

        unlock.setOnClickListener {
            val mk = vault.unlockWithPin(pin.text.toString())
            if (mk == null) {
                status.text = getString(R.string.pin_wrong)
                pin.setText("")
            } else {
                openDb(mk)
                showHome()
            }
        }
        pin.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { unlock.performClick(); true } else false
        }
        swap(v)
        if (canBiometric) pin.post { tryBiometricUnlock() }
    }

    private fun tryBiometricUnlock() {
        try {
            val cipher = vault.prepareKeystoreDecryptCipher()
            val prompt = BiometricPrompt(
                this,
                ContextCompat.getMainExecutor(this),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val cryptoCipher = result.cryptoObject?.cipher ?: return
                        val mk = vault.unlockWithKeystoreCipher(cryptoCipher)
                        if (mk != null) {
                            openDb(mk)
                            showHome()
                        }
                    }
                }
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.biometric_title))
                .setSubtitle(getString(R.string.biometric_subtitle))
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        } catch (_: Exception) {
            // Clave Keystore invalidada (re-enrolamiento) → desbloqueo por PIN
        }
    }

    // ------------------------------------------------------------------
    // HOME
    // ------------------------------------------------------------------

    private fun showHome() {
        val v = inflate(R.layout.screen_home)
        v.findViewById<View>(R.id.btn_new_license).setOnClickListener { renewSource = null; showNewLicense() }
        v.findViewById<View>(R.id.btn_history).setOnClickListener { showHistory() }
        v.findViewById<View>(R.id.btn_backup).setOnClickListener { showBackup() }
        v.findViewById<View>(R.id.btn_settings).setOnClickListener { showSettings() }
        v.findViewById<View>(R.id.btn_lock).setOnClickListener { lock() }
        val records = db?.listLicenses() ?: emptyList()
        val active = records.count { it.status == LicenseRecord.Status.ACTIVE }
        v.findViewById<TextView>(R.id.home_stats).text = getString(R.string.home_stats, records.size, active)
        swap(v)
    }

    // ------------------------------------------------------------------
    // NUEVA LICENCIA / RENOVACIÓN
    // ------------------------------------------------------------------

    private class InputException(message: String) : Exception(message)

    private fun showNewLicense() {
        val v = inflate(R.layout.screen_new_license)
        val title = v.findViewById<TextView>(R.id.new_license_title)
        val requestCode = v.findViewById<EditText>(R.id.request_code)
        val validateBtn = v.findViewById<View>(R.id.btn_validate)
        val cust = v.findViewById<TextView>(R.id.req_customer)
        val deviceInfo = v.findViewById<TextView>(R.id.req_device)
        val options = v.findViewById<View>(R.id.issue_options)
        val status = v.findViewById<TextView>(R.id.new_license_status)
        val resultBox = v.findViewById<EditText>(R.id.token_result)
        val resultLabel = v.findViewById<TextView>(R.id.result_label)
        val copyBtn = v.findViewById<View>(R.id.btn_copy_token)
        val planGroup = v.findViewById<RadioGroup>(R.id.plan_group)
        val customDays = v.findViewById<EditText>(R.id.custom_days)
        val allowShorten = v.findViewById<CheckBox>(R.id.allow_shorten)
        var currentRequest: RequestPayload? = null

        val src = renewSource
        if (src != null) {
            title.text = getString(R.string.renew_title)
            requestCode.visibility = View.GONE
            validateBtn.visibility = View.GONE
            cust.text = src.customerName
            deviceInfo.text = getString(R.string.device_info_masked, Fmt.maskInstallation(src.installationId))
            options.visibility = View.VISIBLE
            currentRequest = RequestPayload(2, "ViewLBA-Server", src.customerName, src.installationId, src.diskId, "renewal", 0, "renewal")
        }

        validateBtn.setOnClickListener {
            status.text = ""
            try {
                val req = requireEngine().openRequest(requestCode.text.toString())
                currentRequest = req
                cust.text = req.customerName
                deviceInfo.text = getString(R.string.device_info_masked, Fmt.maskInstallation(req.installationId))
                options.visibility = View.VISIBLE
                status.text = getString(R.string.request_valid)
            } catch (e: Exception) {
                options.visibility = View.GONE
                status.text = e.message ?: getString(R.string.generic_error)
            }
        }

        planGroup.setOnCheckedChangeListener { _, checkedId ->
            customDays.visibility = if (checkedId == R.id.plan_custom) View.VISIBLE else View.GONE
        }

        v.findViewById<View>(R.id.btn_generate).setOnClickListener {
            status.text = ""
            try {
                val req = currentRequest ?: throw InputException(getString(R.string.validate_first))
                val plan: IssueOptions.Plan = when (planGroup.checkedRadioButtonId) {
                    R.id.plan_monthly -> IssueOptions.Plan.MONTHLY
                    R.id.plan_annual -> IssueOptions.Plan.ANNUAL
                    else -> IssueOptions.Plan.CUSTOM
                }
                val days = if (plan == IssueOptions.Plan.CUSTOM) {
                    customDays.text.toString().trim().toIntOrNull()
                        ?: throw InputException(getString(R.string.custom_days_hint))
                } else {
                    if (plan == IssueOptions.Plan.MONTHLY) 30 else 365
                }

                val now = System.currentTimeMillis()
                // Renovación: el inicio por defecto extiende desde el vencimiento
                // actual (nunca acorta; anti-downgrade).
                val startDefault = if (src != null && src.expiresAt > now) src.expiresAt else now

                val opts = IssueOptions(
                    plan = plan,
                    durationDays = days,
                    startsAt = startDefault,
                    allowShorten = allowShorten.isChecked,
                )

                val (token, record) = if (src != null) {
                    requireEngine().renewFromRecord(src, opts)
                } else {
                    requireEngine().issueFromRequest(req, opts)
                }

                resultBox.setText(token)
                resultLabel.visibility = View.VISIBLE
                resultBox.visibility = View.VISIBLE
                copyBtn.visibility = View.VISIBLE
                status.text = getString(R.string.issued_ok, record.customerName, record.durationDays, Fmt.day(record.expiresAt))
                copyToken(token)
            } catch (e: Exception) {
                status.text = e.message ?: getString(R.string.generic_error)
            }
        }

        copyBtn.setOnClickListener {
            resultBox.text?.toString()?.takeIf { it.isNotBlank() }?.let { copyToken(it) }
        }

        v.findViewById<View>(R.id.btn_back).setOnClickListener { renewSource = null; showHome() }
        swap(v)
    }

    private fun requireEngine(): LicenseEngine = engine ?: throw IllegalStateException(getString(R.string.locked_error))

    // ------------------------------------------------------------------
    // HISTORIAL + DETALLE
    // ------------------------------------------------------------------

    private fun showHistory() {
        val v = inflate(R.layout.screen_history)
        val search = v.findViewById<EditText>(R.id.history_search)
        val list = v.findViewById<LinearLayout>(R.id.history_list)
        val status = v.findViewById<TextView>(R.id.history_status)
        val filterGroup = v.findViewById<RadioGroup>(R.id.filter_group)

        fun render() {
            val database = db ?: return
            list.removeAllViews()
            val query = search.text.toString().takeIf { it.isNotBlank() }
            val filter = when (filterGroup.checkedRadioButtonId) {
                R.id.filter_active -> Db.StatusFilter.ACTIVE
                R.id.filter_expired -> Db.StatusFilter.EXPIRED
                R.id.filter_future -> Db.StatusFilter.FUTURE
                else -> Db.StatusFilter.ALL
            }
            val records = database.listLicenses(query, filter)
            status.text = getString(R.string.history_count, records.size)
            for (r in records) {
                val row = LayoutInflater.from(this).inflate(R.layout.item_license, list, false)
                row.findViewById<TextView>(R.id.item_customer).text = r.customerName
                row.findViewById<TextView>(R.id.item_license_id).text = r.licenseId
                row.findViewById<TextView>(R.id.item_dates).text = "${Fmt.days(r.durationDays.toLong())} · vence ${Fmt.day(r.expiresAt)}"
                val badge = row.findViewById<TextView>(R.id.item_status)
                badge.text = r.status.label
                badge.setTextColor(
                    when (r.status) {
                        LicenseRecord.Status.ACTIVE -> getColor(R.color.status_active)
                        LicenseRecord.Status.EXPIRED -> getColor(R.color.status_expired)
                        LicenseRecord.Status.FUTURE -> getColor(R.color.status_future)
                    }
                )
                row.setOnClickListener { showDetail(r) }
                list.addView(row)
            }
        }

        search.setOnEditorActionListener { _, _, _ -> render(); true }
        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) = render()
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        filterGroup.setOnCheckedChangeListener { _, _ -> render() }
        v.findViewById<View>(R.id.btn_back).setOnClickListener { showHome() }
        render()
        swap(v)
    }

    private fun showDetail(record: LicenseRecord) {
        val v = inflate(R.layout.screen_detail)
        v.findViewById<TextView>(R.id.detail_customer).text = record.customerName
        v.findViewById<TextView>(R.id.detail_fields).text = buildString {
            appendLine(getString(R.string.detail_license_id, record.licenseId))
            appendLine(getString(R.string.detail_plan, planLabel(record.plan), record.durationDays))
            appendLine(getString(R.string.detail_start, Fmt.day(record.startsAt)))
            appendLine(getString(R.string.detail_expiry, Fmt.day(record.expiresAt)))
            appendLine(getString(R.string.detail_days_left, Fmt.days(Fmt.daysLeft(record.expiresAt))))
            append(getString(R.string.detail_status, record.status.label))
        }
        v.findViewById<View>(R.id.btn_copy_token).setOnClickListener { copyToken(record.token) }
        v.findViewById<View>(R.id.btn_renew).setOnClickListener {
            renewSource = record
            showNewLicense()
        }
        v.findViewById<View>(R.id.btn_back).setOnClickListener { showHistory() }
        swap(v)
    }

    private fun planLabel(plan: String): String = when (plan) {
        "monthly" -> "Mensual"
        "annual" -> "Anual"
        else -> "Personalizada"
    }

    // ------------------------------------------------------------------
    // BACKUP (.vlbak)
    // ------------------------------------------------------------------

    private fun showBackup() {
        val v = inflate(R.layout.screen_backup)
        val status = v.findViewById<TextView>(R.id.backup_status)
        val lastBackup = db?.getSetting("last_backup_at")?.toLongOrNull()
        v.findViewById<TextView>(R.id.last_backup).text =
            lastBackup?.let { getString(R.string.last_backup, Fmt.dayTime(it)) } ?: getString(R.string.no_backup_yet)

        v.findViewById<View>(R.id.btn_create_backup).setOnClickListener {
            askPassword(getString(R.string.backup_password_title)) { pwd ->
                pendingBackupPassword = pwd
                startActivityForResult(
                    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "application/octet-stream"
                        putExtra(Intent.EXTRA_TITLE, "viewlba-${Fmt.day(System.currentTimeMillis()).replace("/", "")}.vlbak")
                    },
                    REQ_CREATE_BACKUP
                )
            }
        }
        v.findViewById<View>(R.id.btn_restore_backup).setOnClickListener {
            askPassword(getString(R.string.restore_password_title)) { pwd ->
                pendingRestorePassword = pwd
                openDocumentFor(REQ_RESTORE_BACKUP)
            }
        }
        v.findViewById<View>(R.id.btn_verify_backup).setOnClickListener {
            askPassword(getString(R.string.verify_password_title)) { pwd ->
                pendingVerifyPassword = pwd
                openDocumentFor(REQ_VERIFY_BACKUP)
            }
        }
        v.findViewById<View>(R.id.btn_back).setOnClickListener { showHome() }
        swap(v)
    }

    private fun openDocumentFor(code: Int) {
        startActivityForResult(
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            },
            code
        )
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != Activity.RESULT_OK || data == null) return
        val uri: Uri = data.data ?: return
        when (requestCode) {
            REQ_CREATE_BACKUP -> pendingBackupPassword?.let { createBackup(uri, it) }
            REQ_RESTORE_BACKUP -> pendingRestorePassword?.let { restoreBackup(uri, it) }
            REQ_VERIFY_BACKUP -> pendingVerifyPassword?.let { verifyBackup(uri, it) }
        }
        pendingBackupPassword = null
        pendingRestorePassword = null
        pendingVerifyPassword = null
    }

    private fun readBytes(uri: Uri): ByteArray? = contentResolver.openInputStream(uri)?.use { it.readBytes() }

    private fun backupStatusView(): TextView? = container?.findViewById(R.id.backup_status)

    private fun createBackup(uri: Uri, password: String) {
        val database = db ?: return
        bg.execute {
            try {
                val snapshot = database.snapshot()
                val json = BackupEnvelope.snapshotToJson(
                    schema = snapshot.schema,
                    exportedAt = snapshot.exportedAt,
                    keys = snapshot.keys.entries.associate { (id, k) ->
                        id to BackupEnvelope.DbKey(k.publicB64, k.privateBytes, k.createdAt)
                    },
                    licenses = snapshot.licenses.map {
                        BackupEnvelope.DbLicense(
                            it.licenseId, it.customerName, it.plan, it.durationDays, it.issuedAt, it.startsAt,
                            it.expiresAt, it.installationId, it.diskId, it.requestHash, it.token, it.createdAt, it.updatedAt
                        )
                    },
                    requests = snapshot.requests.map { BackupEnvelope.DbRequest(it.first, it.second, it.third) },
                    settings = snapshot.settings,
                )
                val bytes = BackupEnvelope.encrypt(json, password.toCharArray())
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                    ?: throw BackupEnvelope.BackupException("No se pudo escribir el archivo")
                database.putSetting("last_backup_at", System.currentTimeMillis().toString())
                database.audit("backup_created", "licencias=${snapshot.licenses.size}")
                runOnUiThread {
                    backupStatusView()?.text = getString(R.string.backup_created, snapshot.licenses.size)
                    container?.findViewById<TextView>(R.id.last_backup)?.text =
                        getString(R.string.last_backup, Fmt.dayTime(System.currentTimeMillis()))
                    Toast.makeText(this, R.string.backup_created_toast, Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread { backupStatusView()?.text = e.message ?: getString(R.string.generic_error) }
            }
        }
    }

    private fun restoreBackup(uri: Uri, password: String) {
        val database = db ?: return
        bg.execute {
            try {
                val bytes = readBytes(uri) ?: throw BackupEnvelope.BackupException("No se pudo leer el archivo")
                val data = BackupEnvelope.decrypt(bytes, password.toCharArray())
                database.restoreSnapshot(
                    Db.Snapshot(
                        schema = data.schema,
                        exportedAt = data.exportedAt,
                        keys = data.keys.entries.associate { (id, k) -> id to Db.KeyMaterial(k.publicB64, k.privateBytes, k.createdAt) },
                        licenses = data.licenses.map { it.toRecord(0) },
                        requests = data.requests.map { Triple(it.requestHash, it.requestedAt, it.customerName) },
                        settings = data.settings,
                    )
                )
                runOnUiThread {
                    backupStatusView()?.text = getString(R.string.backup_restored, data.licenses.size)
                    Toast.makeText(this, getString(R.string.backup_restored_toast, data.licenses.size), Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread { backupStatusView()?.text = e.message ?: getString(R.string.generic_error) }
            }
        }
    }

    /** Verificación de integridad: descifra y parsea SIN importar nada. */
    private fun verifyBackup(uri: Uri, password: String) {
        bg.execute {
            try {
                val bytes = readBytes(uri) ?: throw BackupEnvelope.BackupException("No se pudo leer el archivo")
                val version = BackupEnvelope.verifyStructure(bytes)
                val data = BackupEnvelope.decrypt(bytes, password.toCharArray())
                runOnUiThread {
                    backupStatusView()?.text = getString(
                        R.string.backup_verified, version, data.licenses.size, data.keys.size, Fmt.dayTime(data.exportedAt)
                    )
                }
            } catch (e: Exception) {
                runOnUiThread { backupStatusView()?.text = e.message ?: getString(R.string.generic_error) }
            }
        }
    }

    // ------------------------------------------------------------------
    // AJUSTES
    // ------------------------------------------------------------------

    private fun showSettings() {
        val v = inflate(R.layout.screen_settings)
        val pubs = engine?.publicKeys()
        val pubEd = pubs?.first
        val pubX = pubs?.second
        v.findViewById<TextView>(R.id.settings_keys).text =
            if (pubEd != null && pubX != null) getString(R.string.keys_configured) else getString(R.string.keys_missing)
        v.findViewById<TextView>(R.id.pub_ed).text = pubEd ?: "—"
        v.findViewById<TextView>(R.id.pub_x).text = pubX ?: "—"
        v.findViewById<View>(R.id.btn_copy_pub_ed).setOnClickListener { pubEd?.let { copyToken(it) } }
        v.findViewById<View>(R.id.btn_copy_pub_x).setOnClickListener { pubX?.let { copyToken(it) } }

        v.findViewById<View>(R.id.btn_import_keys).setOnClickListener { showImportKeysDialog() }
        v.findViewById<View>(R.id.btn_generate_keys).setOnClickListener { showGenerateKeysDialog() }
        v.findViewById<View>(R.id.btn_change_pin).setOnClickListener { showChangePinDialog() }

        v.findViewById<View>(R.id.btn_back).setOnClickListener { showHome() }
        swap(v)
    }

    private fun showImportKeysDialog() {
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.import_keys_title)
            .setView(R.layout.dialog_import_keys)
            .setPositiveButton(R.string.import_action) { d, _ ->
                val dlg = d as AlertDialog
                val ed = dlg.findViewById<EditText>(R.id.import_ed)?.text?.toString()?.trim() ?: ""
                val xv = dlg.findViewById<EditText>(R.id.import_x)?.text?.toString()?.trim() ?: ""
                if (ed.isBlank() || xv.isBlank()) {
                    Toast.makeText(this, R.string.import_keys_missing, Toast.LENGTH_LONG).show()
                } else {
                    try {
                        requireEngine().importKeys(ed, xv)
                        Toast.makeText(this, R.string.keys_imported_ok, Toast.LENGTH_LONG).show()
                        showSettings()
                    } catch (e: Exception) {
                        Toast.makeText(this, e.message ?: getString(R.string.generic_error), Toast.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showGenerateKeysDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.generate_keys_title)
            .setMessage(R.string.generate_keys_warning)
            .setPositiveButton(R.string.generate_action) { _, _ ->
                try {
                    requireEngine().generateKeys()
                    Toast.makeText(this, R.string.keys_generated_ok, Toast.LENGTH_LONG).show()
                    showSettings()
                } catch (e: Exception) {
                    Toast.makeText(this, e.message ?: getString(R.string.generic_error), Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showChangePinDialog() {
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.change_pin_title)
            .setView(R.layout.dialog_change_pin)
            .setPositiveButton(R.string.change_action) { d, _ ->
                val dlg = d as AlertDialog
                val old = dlg.findViewById<EditText>(R.id.pin_old)?.text?.toString() ?: ""
                val new = dlg.findViewById<EditText>(R.id.pin_new)?.text?.toString() ?: ""
                if (!vault.isValidPin(new)) {
                    Toast.makeText(this, R.string.pin_policy, Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                val mk = vault.unlockWithPin(old)
                if (mk == null || !vault.changePin(old, new, mk)) {
                    Toast.makeText(this, R.string.pin_change_failed, Toast.LENGTH_LONG).show()
                } else {
                    Toast.makeText(this, R.string.pin_changed, Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------

    private fun copyToken(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("ViewLBA", text))
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
    }

    private fun askPassword(title: String, onOk: (String) -> Unit) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = getString(R.string.backup_password_hint)
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(input)
            .setPositiveButton(R.string.ok) { _, _ -> onOk(input.text.toString()) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
