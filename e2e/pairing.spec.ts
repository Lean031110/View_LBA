/**
 * E2E FASE 32 — Screen pairing por código temporal (flujo de la misión).
 *
 * TV nueva → muestra código de 6 dígitos → ADMIN registra el código con
 * nombre → el token viaja al room `pair:<código>` → la TV lo persiste →
 * queda VERIFICADA → el reinicio conserva la identidad → re-vincular la
 * misma pantalla a otra TV invalida el token anterior.
 *
 * Requiere el stack completo de playwright.config.ts (app + realtime + DB e2e).
 */
import { test, expect, type Browser, type Page } from "@playwright/test"
import { ADMIN, login, realtimeStatus, waitForScreen } from "./helpers"

/** TV NUEVA (contexto limpio, sin localStorage) abierta esperando su código. */
async function freshTvWaiting(browser: Browser): Promise<{ page: Page; code: string }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto("/?view=tv")
  const codeEl = page.getByTestId("pair-code")
  await codeEl.waitFor({ state: "visible", timeout: 20_000 })
  const code = (await codeEl.textContent())?.trim() ?? ""
  if (!/^\d{6}$/.test(code)) throw new Error(`pair-code inválido en la TV: "${code}"`)
  return { page, code }
}

test.describe("#32 pairing por código temporal", () => {
  test("TV nueva se vincula por código → verificada → identidad persiste tras recargar", async ({ page, browser }) => {
    // 1. TV nueva muestra su código de 6 dígitos y espera
    const { page: tv, code } = await freshTvWaiting(browser)
    try {
      // 2. el admin la registra con ese código (nombre/ubicación del flujo real)
      await login(page, ADMIN)
      await page.getByRole("button", { name: "Pantallas", exact: true }).click()
      await page.getByRole("button", { name: "Nueva pantalla" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByPlaceholder("123456").fill(code)
      await dialog.getByPlaceholder("TV Terraza").fill("TV Pairing E2E")
      await dialog.getByPlaceholder("Terraza norte").fill("Salón principal")
      await dialog.getByRole("button", { name: "Guardar" }).click()
      await expect(page.getByText("Pantalla vinculada").first()).toBeVisible({ timeout: 15_000 })

      // 3. la TV recibió el token: el selector se cierra y aparece la identidad
      await expect(tv.getByText("Identificar esta pantalla")).toBeHidden({ timeout: 15_000 })
      const identity = tv.getByText(/^TV-\d{3}$/, { exact: true }).first()
      await identity.waitFor({ state: "visible", timeout: 20_000 })
      const storedCode = await tv.evaluate(() => localStorage.getItem("signage.screenCode"))
      expect(storedCode).toMatch(/^TV-\d{3}$/)

      // 4. token persistido (nunca impreso: vive solo en localStorage de la TV)
      const storedToken = await tv.evaluate(() => localStorage.getItem("signage.screenToken"))
      expect(storedToken ?? "").toHaveLength(32)

      // 5. el realtime la ve ONLINE y VERIFICADA (presentó token válido)
      await waitForScreen(storedCode!, { online: true }, 20_000)
      const st = await realtimeStatus()
      expect(st.screens.find((s) => s.screenCode === storedCode)?.verified).toBe(true)

      // 6. recargar la TV conserva la identidad (reinicio del televisor)
      await tv.reload()
      await tv.getByText(storedCode!, { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 })
      expect(await tv.evaluate(() => localStorage.getItem("signage.screenCode"))).toBe(storedCode)
      expect(await tv.evaluate(() => localStorage.getItem("signage.screenToken"))).toBe(storedToken)
    } finally {
      await tv.close()
    }
  })

  test("re-vincular la misma pantalla a otra TV (Vincular) → el token anterior queda invalidado", async ({ page, browser }) => {
    // 1. TV-A se vincula como pantalla nueva (flujo del test anterior)
    const { page: tvA, code: codeA } = await freshTvWaiting(browser)
    try {
      await login(page, ADMIN)
      await page.getByRole("button", { name: "Pantallas", exact: true }).click()
      await page.getByRole("button", { name: "Nueva pantalla" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByPlaceholder("123456").fill(codeA)
      await dialog.getByPlaceholder("TV Terraza").fill("TV Regen E2E")
      await dialog.getByRole("button", { name: "Guardar" }).click()
      await expect(page.getByText("Pantalla vinculada").first()).toBeVisible({ timeout: 15_000 })
      await expect(tvA.getByText("Identificar esta pantalla")).toBeHidden({ timeout: 15_000 })
      const storedCode = await tvA.evaluate(() => localStorage.getItem("signage.screenCode"))
      expect(storedCode).toMatch(/^TV-\d{3}$/)

      // 2. TV-B (fábrica: otro navegador/TV física) muestra un código NUEVO
      const { page: tvB, code: codeB } = await freshTvWaiting(browser)
      try {
        expect(codeB).not.toBe(codeA)
        // el admin RE-vincula la pantalla EXISTENTE (tarjeta → botón Vincular)
        // con el código de la TV-B → token nuevo al room → TV-B lo recibe
        page.once("dialog", (d) => d.accept(codeB))
        const card = page.locator(".grid > div").filter({ hasText: storedCode! }).first()
        await card.getByRole("button", { name: "Vincular" }).click()
        await expect(page.getByText("Vinculada", { exact: true }).first()).toBeVisible({ timeout: 15_000 })

        // 3. TV-B recibe el token de ESA pantalla y queda verificada
        await expect(tvB.getByText("Identificar esta pantalla")).toBeHidden({ timeout: 15_000 })
        expect(await tvB.evaluate(() => localStorage.getItem("signage.screenCode"))).toBe(storedCode)
        await waitForScreen(storedCode!, { online: true }, 20_000)
        const st = await realtimeStatus()
        expect(st.screens.find((s) => s.screenCode === storedCode)?.verified).toBe(true)
      } finally {
        await tvB.close()
      }

      // 4. TV-A (token ANTIGUO en su localStorage) recarga → registro rechazado
      //    → identidad limpiada → selector de vinculación visible de nuevo
      await tvA.reload()
      const pickerA = tvA.getByText("Identificar esta pantalla")
      await pickerA.waitFor({ state: "visible", timeout: 25_000 })
      expect(await tvA.evaluate(() => localStorage.getItem("signage.screenToken"))).toBeNull()
      expect(await tvA.evaluate(() => localStorage.getItem("signage.screenCode"))).toBeNull()
    } finally {
      await tvA.close()
    }
  })

  test("código de vinculación equivocado (nadie espera) → pantalla creada sin entregar token", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Pantallas", exact: true }).click()
    await page.getByRole("button", { name: "Nueva pantalla" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByPlaceholder("123456").fill("000001") // nadie espera este código
    await dialog.getByPlaceholder("TV Terraza").fill("TV Sin Espera")
    await dialog.getByRole("button", { name: "Guardar" }).click()
    // respuesta documentada: creada pero sin entrega (paired:false)
    await expect(page.getByText(/Ninguna TV esperaba ese código/i).first()).toBeVisible({ timeout: 15_000 })
  })
})
