package com.viewlba.licensegen

import com.viewlba.licensegen.core.IssueOptions
import com.viewlba.licensegen.core.LicensePolicy
import com.viewlba.licensegen.core.PolicyException
import com.viewlba.licensegen.core.Specs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Casos del requisito §21 aplicables al EMISOR (Kotlin):
 * 13 (downgrade), 14-17 (entradas), 21 (renovación), 22-24 (monthly/annual/
 * custom), 4 (replay), 9 (duplicado de licenseId).
 */
class LicensePolicyTest {

    private val day = Specs.DAY_MS

    @Test
    fun `22 - monthly son exactamente 30 días`() {
        LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.MONTHLY, 30, 1000))
        try {
            LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.MONTHLY, 31, 1000))
            throw AssertionError("debió rechazar 31 días en monthly")
        } catch (e: PolicyException) { assertTrue(e.message!!.contains("30")) }
    }

    @Test
    fun `23 - annual son exactamente 365 días`() {
        LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.ANNUAL, 365, 1000))
        try {
            LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.ANNUAL, 300, 1000))
            throw AssertionError("debió rechazar 300 días en annual")
        } catch (_: PolicyException) { }
    }

    @Test
    fun `24 - custom admite 13650 días`() {
        LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.CUSTOM, 1, 1000))
        LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.CUSTOM, 45, 1000))
        LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.CUSTOM, 3650, 1000))
        for (bad in listOf(0, -1, 3651)) {
            try {
                LicensePolicy.validateIssueOptions(IssueOptions(IssueOptions.Plan.CUSTOM, bad, 1000))
                throw AssertionError("debió rechazar durationDays=$bad")
            } catch (_: PolicyException) { }
        }
    }

    @Test
    fun `13 - renovación más corta que la activa → downgrade rechazado`() {
        val now = System.currentTimeMillis()
        val active = listOf((now + 365 * day) to "VLBA-aaaaaaaaaaaa")
        try {
            LicensePolicy.checkDowngrade(now + 30 * day, active, "VLBA-bbbbbbbbbbbb", allowShorten = false)
            throw AssertionError("debió rechazar el downgrade")
        } catch (e: PolicyException) {
            assertTrue(e.message!!.contains("ANTES"))
        }
    }

    @Test
    fun `13 - acortar EXPLÍCITO (acción administrativa) permitido`() {
        val now = System.currentTimeMillis()
        val active = listOf((now + 365 * day) to "VLBA-aaaaaaaaaaaa")
        LicensePolicy.checkDowngrade(now + 30 * day, active, "VLBA-bbbbbbbbbbbb", allowShorten = true)
    }

    @Test
    fun `21 - renovación que extiende permitida`() {
        val now = System.currentTimeMillis()
        val active = listOf((now + 30 * day) to "VLBA-aaaaaaaaaaaa")
        LicensePolicy.checkDowngrade(now + 365 * day, active, "VLBA-bbbbbbbbbbbb", allowShorten = false)
    }

    @Test
    fun `21 - renovación del MISMO licenseId (idempotente en tiempo) permitida`() {
        val now = System.currentTimeMillis()
        val active = listOf((now + 365 * day) to "VLBA-aaaaaaaaaaaa")
        LicensePolicy.checkDowngrade(now + 30 * day, active, "VLBA-aaaaaaaaaaaa", allowShorten = false)
    }

    @Test
    fun `4 - replay - solicitud ya procesada → rechazo con flujo de renovación`() {
        try {
            LicensePolicy.checkReplay("abc", listOf("abc"))
            throw AssertionError("debió rechazar replay")
        } catch (e: PolicyException) {
            assertTrue(e.message!!.contains("Renovar"))
        }
    }

    @Test
    fun `4 - solicitud NUEVA permitida`() {
        LicensePolicy.checkReplay("abc", listOf("def"))
    }

    @Test
    fun `licenseId único - colisiones resueltas`() {
        val existing = setOf("VLBA-000000000000", "VLBA-000000000001")
        val seq = generateSequence(0) { it + 1 }.iterator()
        val id = LicensePolicy.newUniqueLicenseId(existing) { n -> "%0${2 * n}x".format(seq.next()) }
        assertEquals("VLBA-000000000002", id)
    }

    @Test
    fun `inicio de renovación por defecto nunca acorta`() {
        val now = System.currentTimeMillis()
        assertEquals(now + 40 * day, LicensePolicy.renewalDefaultStart(now + 40 * day, now))
        assertEquals(now, LicensePolicy.renewalDefaultStart(now - 10 * day, now))
    }
}
