package com.viewlba.licensegen.core

/**
 * Políticas del emisor (lógica PURA — testeable en JVM):
 *  · validación de duración/plan (la duración la decide SOLO el admin)
 *  · anti-replay (hash de solicitud ya procesado)
 *  · anti-downgrade (renovación no acorta una licencia activa sin acción
 *    administrativa explícita)
 */
object LicensePolicy {

    /** Valida las opciones de emisión. @throws PolicyException */
    fun validateIssueOptions(opts: IssueOptions) {
        if (opts.durationDays < 1 || opts.durationDays > Specs.MAX_CUSTOM_DURATION_DAYS) {
            throw PolicyException("La duración debe estar entre 1 y ${Specs.MAX_CUSTOM_DURATION_DAYS} días")
        }
        when (opts.plan) {
            IssueOptions.Plan.MONTHLY -> if (opts.durationDays != 30) throw PolicyException("El plan Mensual son exactamente 30 días")
            IssueOptions.Plan.ANNUAL -> if (opts.durationDays != 365) throw PolicyException("El plan Anual son exactamente 365 días")
            IssueOptions.Plan.CUSTOM -> Unit // la decide el administrador dentro de los límites
        }
        if (opts.startsAt <= 0) throw PolicyException("Fecha de inicio inválida")
    }

    /**
     * ANTI-REPLAY: ¿esta solicitud ya fue procesada?
     * Una solicitud usada NO puede emitir otra licencia — la renovación pasa
     * por el flujo explícito "Renovar" desde el historial (sin request).
     */
    fun checkReplay(requestHash: String, processedHashes: Collection<String>) {
        if (requestHash in processedHashes) {
            throw PolicyException(
                "Este código de solicitud ya fue usado para emitir una licencia — usa «Renovar» desde el historial para extender la vigencia"
            )
        }
    }

    /**
     * ANTI-DOWNGRADE: la renovación no puede acortar una licencia ACTIVA del
     * mismo equipo, salvo acción administrativa explícita (allowShorten).
     * @param activeLicenses licencias del mismo installationId con vigencia
     *        futura (expiresAt > now).
     */
    fun checkDowngrade(
        newExpiresAt: Long,
        activeLicenses: List<Pair<Long, String>>, // (expiresAt, licenseId)
        newLicenseId: String,
        allowShorten: Boolean,
    ) {
        if (allowShorten) return
        val longest = activeLicenses.filter { it.second != newLicenseId }.maxByOrNull { it.first }
        if (longest != null && newExpiresAt < longest.first) {
            val days = (longest.first - newExpiresAt) / Specs.DAY_MS
            throw PolicyException(
                "La nueva licencia vence ANTES que la activa ($days días menos). Marca «Acortar licencia (acción administrativa)» para confirmar el recorte."
            )
        }
    }

    /** licenseId candidato único contra los existentes (reintento acotado). */
    fun newUniqueLicenseId(existing: Set<String>, randHex: (Int) -> String): String {
        repeat(8) {
            val candidate = "VLBA-${randHex(6)}"
            if (candidate !in existing) return candidate
        }
        throw PolicyException("No se pudo generar un licenseId único (reintentar)")
    }

    /** Inicio por defecto para una RENOVACIÓN: nunca antes de la vigencia actual. */
    fun renewalDefaultStart(currentRecordExpiresAt: Long, now: Long): Long = maxOf(now, currentRecordExpiresAt)
}
