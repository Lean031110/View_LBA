/**
 * E2E — Sistema de licencias v2 (flujo copiar/pegar: criterio de éxito).
 *
 * El entorno E2E corre CON licencia activa (e2e-setup.ts activa un token
 * firmado con la clave DUMMY de test) para no romper los specs existentes.
 * Aquí se ejercita el flujo REAL completo del requisito (sección 25):
 *   CLIENTE:  copiar código → (WhatsApp) → pegar token → activar
 *   ADMIN:    pegar código → elegir 365 días → generar → copiar token
 *
 *   1. Sección Licencia: estado ACTIVA, cliente, fechas, días restantes —
 *      SIN Installation ID, SIN Disk ID, SIN ZIP, SIN JSON
 *   2. TV sin marca de agua con licencia activa
 *   3. "Copiar código de solicitud" genera VLREQ2-… (identidad OCULTA dentro)
 *   4. Pegar token válido → LICENCIA ACTIVA con días restantes
 *   5. Pegar token manipulado/de otro equipo → rechazo humano
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login } from "./helpers"
import { buildE2eLicenseToken, openE2eRequestCode } from "./fixtures/licensing/license-builder"
import { E2E_INSTALLATION_ID } from "./fixtures/licensing/keys"

test.describe("Licencia — vista (estado ocultando la técnica)", () => {
  test("admin ve la sección Licencia con estado ACTIVA, cliente, vencimiento y días restantes", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Licencia" }).click()

    await expect(page.getByRole("heading", { name: "Licencia" })).toBeVisible()
    // estado ACTIVA con cliente de la licencia activada por el setup
    await expect(page.getByText("LICENCIA ACTIVA")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Restaurante E2E").first()).toBeVisible()
    await expect(page.getByText(/Restan \d+ días/).first()).toBeVisible()
    await expect(page.getByText(/Vence el \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible()

    // ⚠ SIN datos técnicos: Installation ID y Disk ID OCULTOS por completo
    await expect(page.getByText(E2E_INSTALLATION_ID, { exact: true })).toHaveCount(0)
    await expect(page.getByText(/Installation ID/i)).toHaveCount(0)
    await expect(page.getByText(/Disk ID/i)).toHaveCount(0)
    // ⚠ sin flujo ZIP/JSON
    await expect(page.getByText(/importar.*zip/i)).toHaveCount(0)
    await expect(page.getByRole("button", { name: /IMPORTAR LICENCIA/ })).toHaveCount(0)
  })

  test("la pantalla TV NO muestra marca de agua con licencia activa", async ({ page }) => {
    await page.goto("/?view=tv")
    // espera a que cargue el contenido (reloj/headers de la TV)
    await page.waitForLoadState("networkidle")
    await expect(page.getByText("VERSIÓN DE PRUEBA")).toHaveCount(0)
    await expect(page.getByText("PERÍODO DE PRUEBA FINALIZADO")).toHaveCount(0)
    await expect(page.getByText("LICENCIA VENCIDA")).toHaveCount(0)
  })

  test("las rutas antiguas ZIP/identity ya no existen (flujo unificado)", async ({ request }) => {
    const identity = await request.get("/api/license/identity")
    expect(identity.status()).toBe(404)
    const imported = await request.post("/api/license/import")
    expect(imported.status()).toBe(404)
  })
})

test.describe("Licencia — flujo copiar/pegar completo (requisito sección 25)", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Licencia" }).click()
    await expect(page.getByText("LICENCIA ACTIVA")).toBeVisible({ timeout: 20_000 })
  })

  test("paso 1: 'Copiar código de solicitud' genera VLREQ2-… con el nombre y la identidad OCULTA dentro", async ({ page }) => {
    await page.getByLabel("Nombre del negocio").fill("Lo D'Leo")
    await page.getByRole("button", { name: /COPIAR CÓDIGO/i }).click()

    // el código aparece en el recuadro copiable
    const codeBox = page.getByLabel("Código de solicitud")
    await expect(codeBox).toBeVisible({ timeout: 15_000 })
    const code = await codeBox.inputValue()
    expect(code.startsWith("VLREQ2-")).toBe(true)
    expect(code.length).toBeGreaterThan(200)

    // ⚠ el código NO muestra el Installation ID en claro (viaja cifrado)
    expect(code).not.toContain(E2E_INSTALLATION_ID)

    // el "emisor" de E2E puede abrirlo y encuentra TODO el binding
    const opened = openE2eRequestCode(code)
    expect(opened.payload.customerName).toBe("Lo D'Leo")
    expect(opened.payload.installationId).toBe(E2E_INSTALLATION_ID)
    expect(opened.requestHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("paso 2: pegar token de renovación (365 días) → LICENCIA ACTIVA y días restantes visibles", async ({ page }) => {
    // renovación: MISMO binding (overrides E2E) con vigencia MÁS LARGA (400)
    const renewal = buildE2eLicenseToken({ customerName: "Lo D'Leo", plan: "custom", durationDays: 400 })
    await page.getByLabel("Token de licencia").fill(renewal)
    await page.getByRole("button", { name: /ACTIVAR LICENCIA/i }).click()

    // resultado con las comprobaciones humanas
    await expect(page.getByText("Token verificado y válido")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Vinculación con este equipo correcta")).toBeVisible()
    await expect(page.getByText("Licencia guardada en el servidor")).toBeVisible()

    // el estado refleja la renovación (400 días > 365 del setup)
    await expect(page.getByText(/Restan 400 días/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Lo D'Leo").first()).toBeVisible()
  })

  test("pegar token MANIPULADO → rechazo humano, nada cambia", async ({ page }) => {
    const token = buildE2eLicenseToken({ customerName: "Falsificado SA", plan: "custom", durationDays: 500 })
    // romper el CRC (cambiar 1 carácter del cuerpo sin re-firmar)
    const pos = token.length - 3
    const tampered = token.slice(0, pos) + (token[pos] === "A" ? "B" : "A") + token.slice(pos + 1)
    await page.getByLabel("Token de licencia").fill(tampered)
    await page.getByRole("button", { name: /ACTIVAR LICENCIA/i }).click()

    await expect(page.getByText("No se pudo activar la licencia").first()).toBeVisible({ timeout: 15_000 })
    // la licencia activa anterior sigue vigente
    await expect(page.getByText("LICENCIA ACTIVA")).toBeVisible()
    await expect(page.getByText("Falsificado SA")).toHaveCount(0)
  })

  test("pegar token de OTRO equipo → rechazo por vinculación (mensaje humano)", async ({ page }) => {
    const foreign = buildE2eLicenseToken({
      customerName: "Otro Restaurante",
      installationId: "VWLB-FFFF-0000-0000-FFFF",
      plan: "custom",
      durationDays: 500,
    })
    await page.getByLabel("Token de licencia").fill(foreign)
    await page.getByRole("button", { name: /ACTIVAR LICENCIA/i }).click()

    await expect(page.getByText("No se pudo activar la licencia").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/NO corresponde a este equipo/i).first()).toBeVisible()
  })
})
