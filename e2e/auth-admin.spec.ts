/**
 * E2E FASE 22 — Autenticación y panel admin.
 *
 * Escenarios de la misión:
 *   #1  Login
 *   #2  Admin dashboard
 *   #15 Usuario sin permisos (VIEWER)
 *   #16 Logout
 *   #17 Sesión invalidada tras cambio de contraseña (authVersion)
 *   #18 Sesión invalidada tras desactivar usuario
 */
import { test, expect } from "@playwright/test"
import { ADMIN, VIEWER, login, loginExpectingError, loggedInPage, apiLogin } from "./helpers"

test.describe("#1 login", () => {
  test("credenciales incorrectas → error genérico (sin revelar usuario)", async ({ page }) => {
    await loginExpectingError(page, { email: "admin@restaurante.com", password: "contraseña-equivocada" })
  })

  test("usuario inexistente → MISMO error genérico", async ({ page }) => {
    await loginExpectingError(page, { email: "nadie@existiera.com", password: "cualquiera123" })
  })

  test("credenciales correctas → dashboard", async ({ page }) => {
    await login(page, ADMIN)
    // la cookie de sesión existe (httpOnly, misma)
    const cookies = await page.context().cookies()
    const session = cookies.find((c) => c.name === "signage_session")
    expect(session).toBeTruthy()
    expect(session?.httpOnly).toBe(true)
  })
})

test.describe("#2 admin dashboard", () => {
  test("muestra el dashboard con datos del sistema", async ({ page }) => {
    await login(page, ADMIN)
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
    // sidebar con las secciones del rol ADMIN
    for (const label of ["Pantallas", "Promociones", "Horarios", "Ticker", "Usuarios", "Apariencia"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible()
    }
    // navegación a una sección y de vuelta
    await page.getByRole("button", { name: "Pantallas", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Pantallas" })).toBeVisible()
    // pantallas del seed visibles (exact: el subtítulo también menciona TV-001)
    await expect(page.getByText("TV-001", { exact: true })).toBeVisible()
    await expect(page.getByText("TV-002", { exact: true })).toBeVisible()
  })
})

test.describe("#15 usuario sin permisos (VIEWER)", () => {
  test("VIEWER: sin sección Usuarios en UI y 403 en la API", async ({ page }) => {
    await login(page, VIEWER)
    // la sección Usuarios NO aparece para VIEWER
    await expect(page.getByRole("button", { name: "Usuarios", exact: true })).toHaveCount(0)
    // ...tampoco Transmisión/Promociones (OPERATOR+)
    await expect(page.getByRole("button", { name: "Transmisión", exact: true })).toHaveCount(0)
    // la API rechaza directamente (autorización real del backend, FASE 4)
    const res = await page.request.get("/api/admin/users")
    expect(res.status()).toBe(403)
  })

  test("VIEWER puede ver pantallas (solo lectura) pero no escribir", async ({ page }) => {
    await login(page, VIEWER)
    await page.getByRole("button", { name: "Pantallas", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Pantallas" })).toBeVisible()
    // sin botón de creación (canEdit = false)
    await expect(page.getByRole("button", { name: "Nueva pantalla" })).toHaveCount(0)
    // el backend rechaza la escritura directa
    const res = await page.request.post("/api/admin/screens", {
      data: { code: "TV-HACK", name: "Hack", location: "", notes: "", active: true },
    })
    expect(res.status()).toBe(403)
  })
})

test.describe("#16 logout", () => {
  test("logout limpia la sesión y vuelve al login", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByTitle("Cerrar sesión").click()
    // vuelve a la pantalla de login
    await expect(page.locator("#email")).toBeVisible({ timeout: 15_000 })
    // la sesión ya no es válida
    const res = await page.request.get("/api/auth/me")
    expect(res.status()).toBe(401)
  })
})

test.describe("#17 sesión invalidada tras cambio de contraseña", () => {
  test("admin cambia la contraseña de VIEWER → su sesión muere (authVersion)", async ({ browser, page }) => {
    // sesión del VIEWER en un contexto independiente
    const viewerPage = await loggedInPage(browser, VIEWER)
    try {
      // el viewer está dentro (dashboard visible)
      await expect(viewerPage.getByRole("heading", { name: "Dashboard" })).toBeVisible()

      // el ADMIN cambia la contraseña desde la UI de usuarios
      await login(page, ADMIN)
      await page.getByRole("button", { name: "Usuarios", exact: true }).click()
      const viewerCard = page.locator("[data-slot=card]", { hasText: "viewer@restaurante.com" })
      await expect(viewerCard).toBeVisible()
      // botón lápiz (editar): switch(0) · lápiz(1) · papelera(2)
      await viewerCard.locator("button").nth(1).click()
      await expect(page.getByText("Editar usuario")).toBeVisible()
      const dialog = page.getByRole("dialog")
      await dialog.locator("input[type=password]").fill("NuevaClave123")
      await dialog.getByRole("button", { name: "Guardar" }).click()
      // exact: el aria-live del toast también lo anuncia (doble match)
      await expect(page.getByText("Usuario guardado", { exact: true })).toBeVisible({ timeout: 15_000 })

      // la sesión del viewer queda invalidada: /me → 401 y reload → login
      const res = await viewerPage.request.get("/api/auth/me")
      expect(res.status()).toBe(401)
      await viewerPage.reload()
      await expect(viewerPage.locator("#email")).toBeVisible({ timeout: 15_000 })
    } finally {
      await viewerPage.context().close()
      // restaurar la contraseña del viewer (los tests posteriores la necesitan:
      // la DB e2e persiste durante toda la corrida)
      try {
        const cookie = await apiLogin(ADMIN)
        const users = (await (await fetch("http://127.0.0.1:3000/api/admin/users", { headers: { cookie } })).json()) as {
          items: { id: string; email: string }[]
        }
        const viewer = users.items.find((u) => u.email === VIEWER.email)
        if (viewer) {
          await fetch(`http://127.0.0.1:3000/api/admin/users/${viewer.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({ password: VIEWER.password, active: true }),
          })
        }
      } catch (e) {
        console.warn("[cleanup #17] no se pudo restaurar el viewer:", (e as Error).message)
      }
    }
  })
})

test.describe("#18 sesión invalidada tras desactivar usuario", () => {
  test("admin desactiva a VIEWER → su sesión muere", async ({ browser, page }) => {
    const viewerPage = await loggedInPage(browser, VIEWER)
    try {
      await expect(viewerPage.getByRole("heading", { name: "Dashboard" })).toBeVisible()

      await login(page, ADMIN)
      await page.getByRole("button", { name: "Usuarios", exact: true }).click()
      // apagar el Switch de la tarjeta del viewer
      const viewerCard = page.locator("[data-slot=card]", { hasText: "viewer@restaurante.com" })
      await expect(viewerCard).toBeVisible()
      await viewerCard.getByRole("switch").click()

      // la sesión del viewer queda invalidada
      await expect
        .poll(async () => (await viewerPage.request.get("/api/auth/me")).status(), { timeout: 15_000 })
        .toBe(401)
      await viewerPage.reload()
      await expect(viewerPage.locator("#email")).toBeVisible({ timeout: 15_000 })
    } finally {
      await viewerPage.context().close()
    }
  })
})
