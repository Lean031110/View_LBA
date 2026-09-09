/**
 * E2E FASE 22 — CRUD de contenido + propagación realtime Admin → TV.
 *
 * Escenarios de la misión:
 *   #5  Crear promoción
 *   #6  Crear plato
 *   #7  Crear schedule
 *   #8  Modificar ticker
 *   #9  Cambiar configuración
 *   #19 Upload válido (PNG real por la UI)
 *   #20 Upload malicioso/inválido (SVG con script + PNG falso)
 *   #22 Ticker (visible en la TV + actualización en vivo)
 *
 * Cada cambio en el admin dispara content:update por realtime → la TV
 * refresca SIN recarga: se verifica en la propia TV abierta.
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login, openTv, bindTvScreen, tinyPng } from "./helpers"

// La TV queda abierta y VINCULADA a TV-001 durante toda la suite de contenido:
// las pantallas emparejadas reciben content:update por realtime (las anónimas
// no entran al room "screens" — FASE 5/32). Así se valida la propagación
// real Admin → API → Realtime Service → TV sin recarga.
let tv: import("@playwright/test").Page | null = null

test.describe.serial("contenido: admin escribe → TV recibe (realtime)", () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    tv = await ctx.newPage()
    await bindTvScreen(tv, "TV-001")
  })

  test.afterAll(async () => {
    await tv?.context().close()
    tv = null
  })

  test("#5 crear promoción → aparece en admin y en la TV vía realtime", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Promociones", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Promociones" })).toBeVisible()

    await page.getByRole("button", { name: "Nueva promoción" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Nueva promoción")).toBeVisible()
    await dialog.getByPlaceholder("BACONBURGER").fill("PROMO E2E VIVA")
    await dialog.getByPlaceholder("$299").fill("$199")
    await dialog.getByRole("button", { name: "Crear promoción" }).click()

    // toast + tarjeta
    await expect(page.getByText("Promoción creada", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("PROMO E2E VIVA").first()).toBeVisible()

    // en la TV (SIN recarga): content:update → fetchContent → carrusel
    // (el carrusel rota cada ~10s; con 3 del seed + la nueva ≤ ~35s)
    await expect(tv!.getByText("PROMO E2E VIVA").first()).toBeVisible({ timeout: 45_000 })
  })

  test("#6 crear plato → aparece en admin y en la TV vía realtime", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Sugerencias del Día", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Sugerencias del Día" })).toBeVisible()

    await page.getByRole("button", { name: "Nuevo plato" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Nuevo plato")).toBeVisible()
    await dialog.getByPlaceholder("CLUB SANDWICH").fill("PLATO E2E DEL DIA")
    await dialog.getByPlaceholder("$450").fill("$350")
    await dialog.getByRole("button", { name: "Guardar" }).click()

    await expect(page.getByText("Plato guardado", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("PLATO E2E DEL DIA").first()).toBeVisible()

    // en la TV: la sugerencia del día rota cada ~7s; con 3 del seed + el nuevo ≤ ~25s
    await expect(tv!.getByText("PLATO E2E DEL DIA").first()).toBeVisible({ timeout: 45_000 })
  })

  test("#7 crear schedule → aparece en el panel y en la TV", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Horarios", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Horarios" })).toBeVisible()

    await page.getByRole("button", { name: "Nuevo horario" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Nuevo horario")).toBeVisible()
    await dialog.getByPlaceholder("DESAYUNO").fill("MERIENDA E2E")
    await dialog.locator("input[type=time]").first().fill("16:00")
    await dialog.locator("input[type=time]").nth(1).fill("18:00")
    await dialog.getByRole("button", { name: "Guardar" }).click()

    await expect(page.getByText("Horario guardado", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("MERIENDA E2E").first()).toBeVisible()
    // el TV muestra el nuevo bloque en la franja superior
    await expect(tv!.getByText("MERIENDA E2E").first()).toBeVisible({ timeout: 25_000 })
  })

  test("#8/#22 ticker: nuevo mensaje → la TV lo muestra en vivo", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Ticker", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Ticker" })).toBeVisible()

    const msg = "MENSAJE TICKER E2E " + Date.now()
    await page.getByPlaceholder("Ej.: Happy Hour de 17:00 a 19:00").fill(msg)
    await page.getByRole("button", { name: "Añadir" }).click()
    // el input se limpia y el mensaje queda persistido (poll: el POST es async;
    // getByDisplayValue ya no existe en Playwright 1.62 → verificación por API)
    await expect(page.getByPlaceholder("Ej.: Happy Hour de 17:00 a 19:00")).toHaveValue("", { timeout: 15_000 })
    await expect
      .poll(
        async () => {
          const ticker = await (await page.request.get("/api/admin/ticker")).json()
          return (ticker.items as { text: string }[]).some((t) => t.text === msg)
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    // #22 la TV muestra el ticker (el nuevo mensaje llega por realtime)
    await expect(tv!.getByText(msg).first()).toBeVisible({ timeout: 45_000 })
    // ...y también los mensajes del seed (ticker operativo de arranque)
    await expect(tv!.getByText("Nuevas promociones disponibles").first()).toBeVisible()
  })

  test("#9 cambiar configuración (color primario) → la TV aplica el tema", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Apariencia", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Apariencia" })).toBeVisible()

    // cambiar el color primario (input[type=color] de la sección Tema y colores)
    await page.locator("input[type=color]").first().fill("#33aaff")
    await page.getByRole("button", { name: "Guardar y publicar" }).click()
    await expect(page.getByText("Cambios publicados", { exact: true })).toBeVisible({ timeout: 15_000 })

    // la TV aplica la variable CSS --tv-primary en vivo (realtime → fetchContent)
    await expect
      .poll(
        async () => {
          const v = await tv!.evaluate(() =>
            getComputedStyle(document.querySelector(".tv-root") as HTMLElement).getPropertyValue("--tv-primary").trim()
          )
          return v
        },
        { timeout: 25_000 }
      )
      .toBe("#33aaff")
  })

  test("#19 upload válido: PNG real desde la UI de logotipo", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Logotipo", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Logotipo" })).toBeVisible()

    const fileInput = page.locator("input[type=file]").first()
    await fileInput.setInputFiles({
      name: "logo-e2e.png",
      mimeType: "image/png",
      buffer: tinyPng(),
    })

    // el campo muestra la imagen subida servida por /api/files/<nombre-servidor>
    const field = page.locator("img[src*='/api/files/']").first()
    await expect(field).toBeVisible({ timeout: 20_000 })

    // el archivo servido responde con content-type imagen y nosniff
    const src = await field.getAttribute("src")
    const res = await page.request.get(src!)
    expect(res.status()).toBe(200)
    expect((res.headers()["content-type"] ?? "").startsWith("image/")).toBe(true)
    expect(res.headers()["x-content-type-options"] ?? "").toContain("nosniff")
  })

  test("#20 upload malicioso: SVG con script y PNG falso son rechazados", async ({ page }) => {
    await login(page, ADMIN)
    await page.getByRole("button", { name: "Logotipo", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Logotipo" })).toBeVisible()

    const fileInput = page.locator("input[type=file]").first()

    // SVG con script embebido (XSS same-origin) → bloqueado por defecto
    await fileInput.setInputFiles({
      name: "malicioso.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'),
    })
    await expect(page.getByText(/SVG deshabilitado/i)).toBeVisible({ timeout: 15_000 })

    // PNG falso: contenido de texto con extensión .png → magic bytes fallan
    await fileInput.setInputFiles({
      name: "falso.png",
      mimeType: "image/png",
      buffer: Buffer.from("esto no es un PNG de verdad, es texto plano"),
    })
    // (razones reales del validador: "no reconocido…" / "no coincide…" / "no válido…")
    await expect(page.getByText(/no reconocido|no coincide|no válido|inválido/i).first()).toBeVisible({
      timeout: 15_000,
    })

    // el campo NO quedó con imagen maliciosa
    await expect(page.locator("img[src*='/api/files/']")).toHaveCount(0)
  })
})
