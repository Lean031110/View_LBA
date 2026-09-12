/**
 * E2E — Sistema de TEMAS TV (v3.1, misión §22).
 *
 * El entorno E2E corre CON licencia ACTIVA (temas habilitados — el gating
 * de trial se prueba en tests/integration/themes-gating.test.ts).
 *
 * Flujo automatizado (requisito §22):
 *   1. login admin (licencia FULL)
 *   2. abrir Theme Manager («Temas de Pantalla»)
 *   3. importar Classic (.vtheme) → 4. validar → 5. aplicar
 *   6. comprobar estado → 7. importar Neon → 8. aplicar
 *   9. volver a Classic → 10. reiniciar (reload) → 11. persistencia
 *  12. eliminar Neon → 13. Default permanece funcional
 *
 * Además (§15 realtime, §16 multi-TV, §23 TV real):
 *   · TV conectada recibe el cambio de tema SIN recargar (realtime)
 *   · dos TVs (TV-001 / TV-002) reciben el tema a la vez
 *   · la TV renderiza el fondo del tema (data-theme-bg)
 *   · paquete MALICIOSO → rechazo humano en la UI (sin crash)
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login, apiLogin, openTv, bindTvScreen } from "./helpers"
import { buildE2eVTheme, buildE2eMaliciousVTheme } from "./fixtures/themes/vtheme-builder"

const CLASSIC_ID = "e2e-classic"
const NEON_ID = "e2e-neon"

/** Limpieza idempotente entre tests: elimina importados de pruebas previas
 *  y vuelve a Default (la DB se resetea por RUN, no por test). */
async function cleanupE2eThemes(): Promise<void> {
  const cookie = await apiLogin(ADMIN)
  for (const id of [CLASSIC_ID, NEON_ID, "evil-e2e"]) {
    await fetch(`http://127.0.0.1:3000/api/admin/themes/${id}`, { method: "DELETE", headers: { cookie } }).catch(() => {})
  }
  await fetch(`http://127.0.0.1:3000/api/admin/themes/default`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "activate" }),
  }).catch(() => {})
}

test.describe("Temas — gestor completo (§22)", () => {
  test.beforeEach(async ({ page }) => {
    await cleanupE2eThemes()
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Temas de Pantalla" }).click()
    await expect(page.getByRole("heading", { name: "Temas de Pantalla" })).toBeVisible()
    // Estado inicial: tema activo = Default
    await expect(page.getByText("Tema activo:").first()).toBeVisible({ timeout: 20_000 })
  })

  test("1-5: importar Classic (.vtheme) → validado, instalado y aplicado", async ({ page }) => {
    // 3. importar
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "ViewLBA-Classic-E2E.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eVTheme("viewlba-classic", CLASSIC_ID),
    })
    // 4. validar (toast de éxito + aparece en el grid).
    //    ⚠ 30s: en dev frío la primera llamada compila la ruta del tema.
    //    ⚠ exact: el aria-live del toast también anuncia el texto (patrón
    //    de auth-admin.spec.ts — evita la violación de modo estricto).
    await expect(page.getByText("Tema importado", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`[data-theme-card="${CLASSIC_ID}"]`)).toBeVisible({ timeout: 15_000 })

    // 5. aplicar
    await page.locator(`[data-theme-card="${CLASSIC_ID}"]`).getByRole("button", { name: "Aplicar" }).click()
    await expect(page.getByText("Tema aplicado", { exact: true })).toBeVisible({ timeout: 15_000 })

    // 6. comprobar estado: el card pasa a «Aplicado» y el banner de activo
    await expect(
      page.locator(`[data-theme-card="${CLASSIC_ID}"]`).getByRole("button", { name: "Aplicado" })
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/Tema activo: ViewLBA Classic E2E/).first()).toBeVisible()
  })

  test("7-8: importar Neon y aplicar (cambio de tema)", async ({ page }) => {
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "ViewLBA-Neon-E2E.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eVTheme("viewlba-neon", NEON_ID),
    })
    await expect(page.locator(`[data-theme-card="${NEON_ID}"]`)).toBeVisible({ timeout: 30_000 })
    await page.locator(`[data-theme-card="${NEON_ID}"]`).getByRole("button", { name: "Aplicar" }).click()
    await expect(page.getByText("Tema aplicado", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Tema activo: ViewLBA Neon E2E/).first()).toBeVisible({ timeout: 10_000 })
  })

  test("9-11: cambiar a Classic, REINICIAR (reload) y comprobar PERSISTENCIA", async ({ page }) => {
    // instalar ambos
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "Classic.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eVTheme("viewlba-classic", CLASSIC_ID),
    })
    await expect(page.locator(`[data-theme-card="${CLASSIC_ID}"]`)).toBeVisible({ timeout: 30_000 })
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "Neon.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eVTheme("viewlba-neon", NEON_ID),
    })
    await expect(page.locator(`[data-theme-card="${NEON_ID}"]`)).toBeVisible({ timeout: 30_000 })

    // 9. aplicar Neon y volver a Classic
    await page.locator(`[data-theme-card="${NEON_ID}"]`).getByRole("button", { name: "Aplicar" }).click()
    await expect(page.getByText(/Tema activo: ViewLBA Neon E2E/).first()).toBeVisible({ timeout: 10_000 })
    await page.locator(`[data-theme-card="${CLASSIC_ID}"]`).getByRole("button", { name: "Aplicar" }).click()
    await expect(page.getByText(/Tema activo: ViewLBA Classic E2E/).first()).toBeVisible({ timeout: 10_000 })

    // 10. reiniciar (recargar el panel — el estado vive en el servidor)
    await page.reload()
    await page.getByRole("button", { name: "Temas de Pantalla" }).click()
    // 11. persistencia: sigue Classic activo
    await expect(page.getByText(/Tema activo: ViewLBA Classic E2E/).first()).toBeVisible({ timeout: 20_000 })
  })

  test("12-13: eliminar Neon → Default permanece funcional", async ({ page }) => {
    // instalar Neon
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "Neon.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eVTheme("viewlba-neon", NEON_ID),
    })
    await expect(page.locator(`[data-theme-card="${NEON_ID}"]`)).toBeVisible({ timeout: 30_000 })

    // 12. eliminar (confirm dialog)
    page.once("dialog", (d) => d.accept())
    await page.locator(`[data-theme-card="${NEON_ID}"]`).getByRole("button", { name: "Eliminar tema" }).click()
    await expect(page.getByText("Tema eliminado", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`[data-theme-card="${NEON_ID}"]`)).toHaveCount(0)

    // 13. el Default NO tiene botón de eliminar y se puede aplicar
    const defaultCard = page.locator('[data-theme-card="default"]')
    await expect(defaultCard.getByRole("button", { name: "Eliminar tema" })).toHaveCount(0)
    // restaurar predeterminado → sigue funcional
    await page.getByRole("button", { name: "Restaurar predeterminado" }).click()
    await expect(page.getByText(/Tema activo: ViewLBA Default/).first()).toBeVisible({ timeout: 15_000 })
  })

  test("paquete MALICIOSO (assets/evil.js) → rechazo humano, sin crash", async ({ page }) => {
    await page.setInputFiles('input[type="file"][accept=".vtheme"]', {
      name: "Malicious.vtheme",
      mimeType: "application/octet-stream",
      buffer: buildE2eMaliciousVTheme(),
    })
    await expect(page.getByText("No se pudo importar el tema", { exact: true })).toBeVisible({ timeout: 30_000 })
    // sin código en el mensaje de error y el gestor sigue vivo
    await expect(page.getByRole("heading", { name: "Temas de Pantalla" })).toBeVisible()
    await expect(page.locator('[data-theme-card="evil-e2e"]')).toHaveCount(0)
  })

  test("tema integrado Classic: aplicar SIN importar (viene de fábrica)", async ({ page }) => {
    const card = page.locator('[data-theme-card="viewlba-classic"]').first()
    await card.getByRole("button", { name: "Aplicar" }).click()
    await expect(page.getByText(/Tema activo: ViewLBA Classic/).first()).toBeVisible({ timeout: 15_000 })
    // restaurar Default para no afectar a otros specs
    await page.getByRole("button", { name: "Restaurar predeterminado" }).click()
    await expect(page.getByText(/Tema activo: ViewLBA Default/).first()).toBeVisible({ timeout: 15_000 })
  })
})

test.describe("Temas — TV real (§15 realtime, §16 multi-TV, §23 render)", () => {
  test("Admin aplica tema → TV conectada lo recibe por REALTIME sin recargar", async ({ page, browser }) => {
    // TV abierta y conectada (identificada como TV-001)
    const tvCtx = await browser.newContext()
    const tv = await tvCtx.newPage()
    await bindTvScreen(tv, "TV-001")
    // fondo del tema Default: sin capa decorativa
    await expect(tv.locator(".tv-theme-bg")).toHaveCount(0)

    // API login del admin (aplicar vía API = mismo backend que la UI)
    const cookie = await apiLogin(ADMIN)

    // instalar + aplicar Classic-E2E vía API (flujo idéntico al de la UI)
    const classic = buildE2eVTheme("viewlba-classic", CLASSIC_ID)
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(classic)], { type: "application/octet-stream" }), "Classic.vtheme")
    const imp = await fetch("http://127.0.0.1:3000/api/admin/themes", {
      method: "POST",
      headers: { cookie },
      body: form,
    })
    expect(imp.ok).toBe(true)
    const act = await fetch(`http://127.0.0.1:3000/api/admin/themes/${CLASSIC_ID}`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    })
    expect(act.ok).toBe(true)

    // §15: la TV recibe content:update → refetch → tema Classic (fondo
    // «gradient») SIN recargar la página
    await expect(tv.locator(".tv-theme-bg[data-theme-bg='gradient']")).toBeVisible({ timeout: 25_000 })

    // §16 multi-TV: una SEGUNDA TV también recibe el tema
    const tv2Ctx = await browser.newContext()
    const tv2 = await tv2Ctx.newPage()
    await bindTvScreen(tv2, "TV-002")
    await expect(tv2.locator(".tv-theme-bg[data-theme-bg='gradient']")).toBeVisible({ timeout: 25_000 })

    // la TV muestra el contenido normal (legibilidad §23 — nombre visible)
    await expect(tv2.getByText("La Terraza Grill & Bar").first()).toBeVisible()

    // cleanup: volver a Default (estado para otros specs)
    await fetch(`http://127.0.0.1:3000/api/admin/themes/default`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    })
    // ambas TVs vuelven al fondo del Default (realtime)
    await expect(tv.locator(".tv-theme-bg")).toHaveCount(0, { timeout: 25_000 })
    await expect(tv2.locator(".tv-theme-bg")).toHaveCount(0, { timeout: 25_000 })

    // eliminar el tema importado (cleanup total)
    await fetch(`http://127.0.0.1:3000/api/admin/themes/${CLASSIC_ID}`, { method: "DELETE", headers: { cookie } })
    await tvCtx.close()
    await tv2Ctx.close()
  })

  test("/api/content expone el tema activo (público, sin rutas internas)", async ({ request }) => {
    const res = await request.get("/api/content")
    expect(res.ok()).toBe(true)
    const bundle = (await res.json()) as { theme: { id: string; name: string; spec: Record<string, unknown>; isDefault: boolean } }
    expect(bundle.theme).toBeTruthy()
    expect(bundle.theme.spec.palette).toBeTruthy()
    // tras el cleanup del spec anterior, el activo es Default
    expect(["default", "viewlba-classic", "e2e-classic"]).toContain(bundle.theme.id)
    // SIN rutas internas del sistema en el bundle
    const raw = JSON.stringify(bundle)
    expect(raw).not.toContain("imported/")
    expect(raw).not.toContain("/tmp/")
    expect(raw).not.toContain("data/themes")
  })
})
