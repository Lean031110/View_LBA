/**
 * E2E FASE 22 — Pantalla TV: contenido, zona horaria y fallback de audio.
 *
 * Escenarios de la misión:
 *   #10 TV carga contenido
 *   #21 Timezone correcto (America/Havana — la del restaurante, no la del navegador)
 *   #23 Audio fallback (setSinkId ausente → salida predeterminada SIN romperse)
 */
import { test, expect } from "@playwright/test"
import { ADMIN, login, openTv, bindTvScreen, startRtmpPublisher, stopPublisher } from "./helpers"

test.describe("#10 TV carga contenido", () => {
  test("módulos del seed: reloj, horarios, platos, promos, redes y ticker", async ({ page }) => {
    // FASE 25: con el stack E2E completo (app+realtime+stream) el health es "ok"
    const h = await page.request.get("/api/health")
    expect(h.status()).toBe(200)
    const hd = (await h.json()) as { status: string; database: { ok: boolean }; realtime: { ok: boolean }; stream: { ok: boolean } }
    expect(hd.status).toBe("ok")
    expect(hd.database.ok).toBe(true)
    expect(hd.realtime.ok).toBe(true)
    expect(hd.stream.ok).toBe(true)

    await openTv(page)

    // reloj (aria-label propio del componente Clock)
    await expect(page.locator('[aria-label="Fecha y hora actual"]')).toBeVisible()

    // horarios del seed
    await expect(page.getByText("DESAYUNO")).toBeVisible()
    await expect(page.getByText("ALMUERZO")).toBeVisible()
    await expect(page.getByText("CENA")).toBeVisible()

    // sugerencias del día (rotativo: al menos una del seed en pocos segundos)
    await expect(page.getByText(/CLUB SANDWICH|SALMÓN A LA PARRILLA|TACOS DE CAMARÓN/).first()).toBeVisible({
      timeout: 20_000,
    })

    // promociones del seed
    await expect(page.getByText(/BACONBURGER|PIZZA FAMILIAR|HAPPY HOUR/).first()).toBeVisible({ timeout: 20_000 })

    // redes sociales del seed
    await expect(page.getByText("@laterraza").first()).toBeVisible()

    // ticker del seed
    await expect(page.getByText("Nuevas promociones disponibles").first()).toBeVisible()
  })
})

test.describe("#21 timezone correcto", () => {
  test("el reloj muestra la hora de America/Havana (Settings.timezone)", async ({ page }) => {
    await openTv(page)
    const clock = page.locator('[aria-label="Fecha y hora actual"]')

    // Hora esperada en la TZ del restaurante, calculada INDEPENDIENTEMENTE en Node
    const expected = new Intl.DateTimeFormat("es-ES", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true, // settings.clockFormat por defecto = "12"
      timeZone: "America/Havana",
    }).format(new Date())

    // tolerancia ±1 min (el minuto puede girar entre cálculo y render)
    const [expH, expM] = expected.replace(/\s?[ap]\.\s?m\./i, "").split(":").map(Number)
    const isPM = /p\.\s?m\./i.test(expected)
    let expMinutes = (isPM ? expH + 12 : expH) * 60 + expM
    if (expH === 12 && !isPM) expMinutes = expM // 12 a.m. → 0h
    if (expH === 12 && isPM) expMinutes = 12 * 60 + expM // 12 p.m. → 12h

    await expect
      .poll(
        async () => {
          const txt = (await clock.textContent()) ?? ""
          const m = txt.match(/(\d{1,2}):(\d{2})/)
          if (!m) return -1
          const pm = /p\.\s?m\./i.test(txt)
          let h = Number(m[1])
          let minutes = (pm ? h + 12 : h) * 60 + Number(m[2])
          if (h === 12 && !pm) minutes = Number(m[2])
          if (h === 12 && pm) minutes = 12 * 60 + Number(m[2])
          const diff = Math.abs(minutes - expMinutes)
          return diff > 720 ? 1440 - diff : diff // wrap medianoche
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(1)

    // día de la semana también en la TZ del restaurante
    const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "America/Havana" })
      .format(new Date())
      .toUpperCase()
    await expect(page.getByText(weekday).first()).toBeVisible()

    // la API entrega la TZ configurada (única fuente de verdad del contenido)
    const res = await page.request.get("/api/content")
    const data = (await res.json()) as { settings: { timezone: string } }
    expect(data.settings.timezone).toBe("America/Havana")
  })
})

test.describe("#23 audio fallback (setSinkId)", () => {
  test("TV sin setSinkId + deviceId configurado → salida predeterminada, sin romperse", async ({ page }) => {
    // Simular un navegador de TV SIN setSinkId (Firefox/Safari/TVs antiguas — FASE 7)
    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
        value: undefined,
        configurable: true,
      })
    })

    // el admin configura una salida de audio PARA TV-001 (deviceId reportado/inventado)
    await login(page, ADMIN)
    const screens = await (await page.request.get("/api/admin/screens")).json()
    const tv001 = (screens.items as { id: string; code: string }[]).find((s) => s.code === "TV-001")
    expect(tv001).toBeTruthy()
    const put = await page.request.put(`/api/admin/screens/${tv001!.id}`, {
      data: { audioDeviceId: "dispositivo-fantasma-e2e" },
    })
    expect(put.status()).toBe(200)

    // abrir la TV vinculada a TV-001 (el deviceId llega como initialSinkId)
    await bindTvScreen(page, "TV-001")

    // capturar la consola: el fallback de audio se informa SIN romper el player
    const consoleMsgs: string[] = []
    page.on("console", (m) => consoleMsgs.push(m.text()))
    // el efecto de audio corre en el primer render (fase connecting del player):
    // forzar una re-evaluación recargando la página con la identidad ya fijada
    await page.reload()
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })

    await expect
      .poll(() => consoleMsgs.join("\n"), { timeout: 20_000 })
      .toContain("[StreamPlayer] setSinkId no soportado")

    // la pantalla SIGUE operativa: contenido y player presentes, sin
    // excepciones propias de la app.
    // (Se tolera la interrupción de play() del navegador al desmontar el
    // <video> en dev/StrictMode — mensaje estándar de Chrome, no un error
    // de la aplicación: https://goo.gl/LdLk22)
    await expect(page.getByText("DESAYUNO")).toBeVisible()
    const pageErrors: string[] = []
    page.on("pageerror", (e) => pageErrors.push(e.message))
    await page.waitForTimeout(1500)
    const realErrors = pageErrors.filter(
      (m) => !m.includes("play() request was interrupted") && !m.includes("media was removed")
    )
    expect(realErrors).toEqual([])
  })
})

test.describe("#34 offline: último contenido conocido (FASE 34)", () => {
  test("servidor caído tras recarga → la TV muestra el último contenido + banner, no pantalla vacía", async ({ page }) => {
    // 1. carga normal: el contenido vivo queda persistido (localStorage)
    await page.goto("/?view=tv")
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })

    // 2. simular servidor caído SOLO para /api/content (el resto del dev server
    //    sigue: en producción real el shell lo serviría el SW desde su cache)
    await page.route("**/api/content", (route) => route.abort())
    await page.reload()

    // 3. la TV ARRANCA con el ÚLTIMO contenido conocido + banner de sin conexión
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/mostrando el último contenido conocido/i)).toBeVisible({ timeout: 10_000 })

    // 4. al recuperar el servidor, el contenido se refresca y el banner desaparece
    await page.unroute("**/api/content")
    await page.reload()
    await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/mostrando el último contenido conocido/i)).toBeHidden({ timeout: 15_000 })
  })

  test("assets de PWA servidos: manifest + service worker (sintaxis válida)", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest")
    expect(manifest.status()).toBe(200)
    const body = (await manifest.json()) as { start_url?: string; display?: string; name?: string }
    expect(body.start_url).toBe("/?view=tv")
    expect(body.display).toBe("fullscreen")

    const sw = await request.get("/sw-tv.js")
    expect(sw.status()).toBe(200)
    const swText = await sw.text()
    // contrato mínimo del SW: nunca cachea rutas privadas del admin
    expect(swText).toContain("/api/admin/")
    expect(swText).toContain("/api/auth/")
    expect(swText).toContain("neverTouch")
  })
})
