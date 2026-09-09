/**
 * E2E FASE 22 — Pantallas: creación, vinculación y ciclo realtime del TV.
 *
 * Escenarios de la misión:
 *   #3  Crear pantalla
 *   #4  Vincular pantalla (identidad del TV)
 *   #11 TV pierde realtime (conexión cortada)
 *   #12 TV reconecta automáticamente (24/7)
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login, bindTvScreen, waitForScreen, realtimeStatus } from "./helpers"

test.describe("#3 crear pantalla", () => {
  test("admin crea una pantalla y el TV la ofrece al vincularse", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Pantallas", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Pantallas" })).toBeVisible()

    // crear TV-E2E
    await page.getByRole("button", { name: "Nueva pantalla" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Nueva pantalla")).toBeVisible()
    await dialog.getByPlaceholder("TV-004").fill("TV-E2E")
    await dialog.getByPlaceholder("TV Terraza").fill("Pantalla de Prueba E2E")
    await dialog.getByPlaceholder("Terraza norte").fill("Zona de test")
    await dialog.getByRole("button", { name: "Guardar" }).click()

    // toast + tarjeta en la lista (exact: el aria-live también lo anuncia)
    await expect(page.getByText("Pantalla guardada", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("TV-E2E")).toBeVisible()
    await expect(page.getByText("Pantalla de Prueba E2E")).toBeVisible()

    // el TV la ve en su selector de identidad (primera visita)
    const tv = await page.context().newPage()
    try {
      await tv.goto("/?view=tv")
      await tv.getByText("Identificar esta pantalla").waitFor({ state: "visible", timeout: 20_000 })
      await expect(tv.getByRole("button", { name: /TV-E2E/ })).toBeVisible()
    } finally {
      await tv.close()
    }
  })
})

test.describe("#4 vincular pantalla", () => {
  test("el TV se vincula a TV-002: identidad persistida + online en realtime", async ({ page }) => {
    await bindTvScreen(page, "TV-002")

    // identidad persistida en el navegador del dispositivo
    const code = await page.evaluate(() => localStorage.getItem("signage.screenCode"))
    expect(code).toBe("TV-002")
    const chosen = await page.evaluate(() => localStorage.getItem("signage.screenChosen"))
    expect(chosen).toBe("1")

    // el indicador de identidad es visible (discreto, arriba)
    await expect(page.getByText("TV-002", { exact: true })).toBeVisible()

    // el servicio realtime la ve ONLINE (registro autenticado por código)
    await waitForScreen("TV-002", { online: true }, 20_000)

    // el admin la ve ONLINE en su panel (socket admins → screens:snapshot)
    const browser = page.context().browser()!
    const admin = await browser.newContext()
    const adminPage = await admin.newPage()
    try {
      await login(adminPage, ADMIN)
      await adminPage.getByRole("button", { name: "Pantallas", exact: true }).click()
      const card = adminPage.locator("[data-slot=card]", { hasText: "TV-002" })
      await expect(card.getByText("ONLINE")).toBeVisible({ timeout: 20_000 })
    } finally {
      await admin.close()
    }
  })

  test("código desconocido → la pantalla NO se registra como TV-XXX arbitraria", async ({ page }) => {
    // identidad inyectada con un código que NO existe → screen:rejected → picker
    await page.goto("/?view=tv")
    await page.evaluate(() => {
      localStorage.setItem("signage.screenCode", "TV-FANTASMA")
      localStorage.setItem("signage.screenChosen", "1")
    })
    await page.reload()
    // el servicio rechaza el registro → el TV reabre el selector para re-vincular
    await expect(page.getByText("Identificar esta pantalla")).toBeVisible({ timeout: 20_000 })
    // y NO aparece en /status del servicio realtime
    const st = await realtimeStatus()
    expect(st.screens.find((s) => s.screenCode === "TV-FANTASMA")).toBeUndefined()
  })
})

test.describe("#11/#12 TV pierde y recupera realtime", () => {
  test("corte de red → offline en realtime; red vuelve → reconexión automática", async ({ page }) => {
    await bindTvScreen(page, "TV-002")
    await waitForScreen("TV-002", { online: true }, 20_000)

    // ---- #11: la TV pierde la conexión realtime (red del TV caída) ----
    await page.context().setOffline(true)
    await waitForScreen("TV-002", { online: false }, 25_000)

    // ---- #12: la red vuelve → socket.io reconecta solo (24/7, Infinity) ----
    await page.context().setOffline(false)
    await waitForScreen("TV-002", { online: true }, 30_000)

    // el TV sigue mostrando contenido (no se rompió la página)
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible()
  })

  test("caída SOLO del websocket (backend realtime muerto) → TV a la espera sin romperse", async ({ page }) => {
    // Resiliencia del CLIENTE: socket.io reconnectionAttempts=Infinity.
    // (El ciclo completo de reinicio del SERVICIO es FASE 33 recovery.)
    await bindTvScreen(page, "TV-002")
    await waitForScreen("TV-002", { online: true }, 20_000)

    // bloquear TODO websocket hacia :3003 (path "/" de socket.io — matching por host:puerto)
    await page.routeWebSocket(/127\.0\.0\.1:3003/, (ws) => {
      ws.close({ code: 1006 })
    })
    // recargar: el socket de la nueva página queda interceptado y cerrado
    await page.reload()
    await waitForScreen("TV-002", { online: false }, 25_000)

    // el contenido HTTP sigue visible y la página no se rompe
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible()
  })
})
