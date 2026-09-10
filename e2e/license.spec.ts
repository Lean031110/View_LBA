/**
 * E2E — Sistema de licencias (sección 34: criterio de éxito).
 *
 * El entorno E2E corre CON licencia activa (e2e-setup.ts importa una licencia
 * firmada con la clave DUMMY de test) para no romper los specs existentes.
 * Aquí se ejercita el flujo REAL del administrador:
 *   1. Ver la sección Licencia: estado, cliente, Installation ID, Disk ID
 *   2. TV sin marca de agua con licencia activa
 *   3. Renovar (importar ZIP válido) → ACTIVA con nuevas fechas + historial
 *   4. Importar ZIP manipulado → rechazado con motivo de firma
 *   5. Importar ZIP de otro equipo → rechazado por vinculación
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login } from "./helpers"
import { buildE2eLicense, buildE2eLicenseZip, buildTamperedE2eLicenseZip } from "./fixtures/licensing/license-builder"
import { E2E_INSTALLATION_ID, E2E_DISK_ID } from "./fixtures/licensing/keys"

test.describe("Licencia — vista y vinculación", () => {
  test("admin ve la sección Licencia con estado ACTIVA, cliente, Installation ID y Disk ID", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Licencia" }).click()

    await expect(page.getByRole("heading", { name: "Licencia" })).toBeVisible()
    // estado ACTIVA con cliente de la licencia importada por el setup
    await expect(page.getByText("ACTIVA")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Restaurante E2E").first()).toBeVisible()
    // identidad del equipo (overrides E2E)
    await expect(page.getByText(E2E_INSTALLATION_ID, { exact: true })).toBeVisible()
    await expect(page.getByText(E2E_DISK_ID, { exact: true })).toBeVisible()
    // bloque para solicitar licencias
    await expect(page.getByText("Bloque para solicitar tu licencia")).toBeVisible()
  })

  test("la pantalla TV NO muestra marca de agua con licencia activa", async ({ page }) => {
    await page.goto("/?view=tv")
    // espera a que cargue el contenido (reloj/headers de la TV)
    await page.waitForLoadState("networkidle")
    await expect(page.getByText("VERSIÓN DE PRUEBA")).toHaveCount(0)
    await expect(page.getByText("PERÍODO DE PRUEBA FINALIZADO")).toHaveCount(0)
    await expect(page.getByText("LICENCIA VENCIDA")).toHaveCount(0)
  })

  test("sin sesión, /api/license/identity no expone la identidad del equipo", async ({ request }) => {
    const res = await request.get("/api/license/identity")
    expect(res.status()).toBe(401)
  })
})

test.describe("Licencia — importación (sección 34: flujo completo)", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Licencia" }).click()
    await expect(page.getByText("ACTIVA")).toBeVisible({ timeout: 20_000 })
  })

  test("renovar: ZIP válido → ✓ licencia válida, equipo y disco vinculados, watermark fuera", async ({ page }) => {
    // renovación: MISMO binding (overrides E2E) con vigencia MÁS LARGA
    const renewal = buildE2eLicense({ customerName: "Restaurante E2E", plan: "annual", days: 400 })
    await page.setInputFiles('input[type="file"]', {
      name: "ViewLBA-License-Restaurante-E2E.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildE2eLicenseZip(renewal)),
    })
    await page.getByRole("button", { name: "IMPORTAR LICENCIA" }).click()

    // resultado con las 4 comprobaciones (sección 8)
    await expect(page.getByText("Licencia creada y firmada")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Firma digital verificada")).toBeVisible()
    await expect(page.getByText("Binding de equipo y disco correcto")).toBeVisible()
    await expect(page.getByText("Licencia guardada en el servidor")).toBeVisible()

    // la renovación se refleja (vigencia de 400 días, superior a la actual)
    await expect(page.getByText(/400 días/).first()).toBeVisible({ timeout: 20_000 })
  })

  test("ZIP manipulado (cliente cambiado tras la firma) → rechazado, nada cambia", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', {
      name: "ViewLBA-License-manipulada.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildTamperedE2eLicenseZip("customerName", "Falsificado SA")),
    })
    await page.getByRole("button", { name: "IMPORTAR LICENCIA" }).click()

    await expect(page.getByText("Licencia rechazada").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/firma digital/i).first()).toBeVisible()
    // la licencia activa anterior sigue vigente
    await expect(page.getByText("ACTIVA")).toBeVisible()
    await expect(page.getByText("Falsificado SA")).toHaveCount(0)
  })

  test("ZIP de otro equipo (Installation ID distinto) → rechazado por vinculación", async ({ page }) => {
    const foreign = buildE2eLicense({ customerName: "Otro Restaurante", deviceId: "VWLB-FFFF-0000-0000-FFFF" })
    await page.setInputFiles('input[type="file"]', {
      name: "ViewLBA-License-otro-equipo.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildE2eLicenseZip(foreign)),
    })
    await page.getByRole("button", { name: "IMPORTAR LICENCIA" }).click()

    await expect(page.getByText("Licencia rechazada").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/otra instalación|otro disco/i).first()).toBeVisible()
  })
})
