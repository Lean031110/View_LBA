package com.viewlba.licensegen.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Formato humano de fechas/días (es). */
object Fmt {
    private val DAY = SimpleDateFormat("dd/MM/yyyy", Locale.US)

    /** "12/09/2027" */
    fun day(ms: Long): String = DAY.format(Date(ms))

    /** "12/09/2027 15:30" */
    fun dayTime(ms: Long): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.US).format(Date(ms))

    /** "365 días" / "1 día" */
    fun days(n: Long): String = if (n == 1L) "1 día" else "$n días"

    /** Días restantes (techo 0). */
    fun daysLeft(expiresAt: Long, now: Long = System.currentTimeMillis()): Long =
        maxOf(0L, (expiresAt - now + 86_399_999L) / 86_400_000L)

    /**
     * Enmascara un Installation ID en el medio: VWLB-0094-••••-••••-8905
     * (el administrador ve suficiente para identificar, sin exponer el
     * identificador completo en pantalla).
     */
    fun maskInstallation(id: String): String {
        val parts = id.split("-")
        if (parts.size != 5) return "VWLB-••••"
        return "${parts[0]}-${parts[1]}-••••-••••-${parts[4]}"
    }

    fun maskDisk(id: String): String {
        val parts = id.split("-")
        if (parts.size != 4) return "DSK-••••"
        return "${parts[0]}-••••-••••-${parts[3]}"
    }
}
