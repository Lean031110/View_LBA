/**
 * screenshots-capture.ts — capturas de pantalla profesionales del README.
 *
 * Requisitos (scripts/screenshots-stack.sh + screenshots-stream.sh +
 * scripts/screenshots-realtime.sh si se reinició el realtime):
 *   · web       → http://127.0.0.1:3000 (build standalone, DB e2e con seed demo)
 *   · realtime  → :3003/:3004 (estado de pantallas + stream para el Dashboard)
 *   · stream    → :1935/:8000/:8100 con publicación RTMP ACTIVA (ffmpeg Ken Burns)
 *
 * Orden clave: el Dashboard del panel solo recibe el estado de la transmisión
 * por PUSH (evento stream:server). Por eso la TV se abre DESPUÉS de cargar el
 * Dashboard: la conexión de su espectador dispara el broadcast y el panel pasa
 * a "EN DIRECTO · N espectador(es)" — el flujo real del producto.
 *
 * Salidas (docs/screenshots/, 1920×1080 @2x; reescalar luego a 2560×1440):
 *   · launcher.png         — página principal (acceso TV / administración)
 *   · tv-display.png       — pantalla TV en horizontal con transmisión EN VIVO
 *   · admin-dashboard.png  — panel: EN DIRECTO + TV-001 ONLINE + realtime
 *   · admin-stream.png     — panel: sección Transmisión (URL RTMP + métricas)
 *
 * Además renderiza los logos (/logo.svg, /logo-mark.svg) en scripts/.run/
 * para verificación visual (NO se commitean).
 */
import { chromium, expect } from "@playwright/test"
import sharp from "sharp"
import { renameSync, unlinkSync } from "fs"

const BASE = "http://127.0.0.1:3000"
const OUT = "docs/screenshots"
const RUN = "scripts/.run"

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    locale: "es-ES",
    timezoneId: "America/Havana",
  })
  const page = await ctx.newPage()

  // ---------------------------------------------------------------- 0) logos
  // Render de los assets dentro de un HTML neutro (el screenshot de un
  // documento SVG plano no es fiable) — fondo oscuro como en la app
  async function renderLogo(src: string, out: string) {
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#0b0b0f;display:flex;align-items:center;justify-content:center;height:100vh">
         <img src="${src}" style="height:360px">
       </body></html>`
    )
    await expect(page.locator("img")).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: out, clip: { x: 0, y: 190, width: 1920, height: 700 } })
  }
  await renderLogo(`${BASE}/logo.svg`, `${RUN}/logo-render.png`)
  await renderLogo(`${BASE}/logo-mark.svg`, `${RUN}/logo-mark-render.png`)
  console.log("✓ logos renderizados (scripts/.run/logo-render.png · logo-mark-render.png)")

  // ---------------------------------------------------------------- 1) launcher
  await page.goto(BASE)
  await expect(page.locator('img[src="/logo.svg"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("heading", { name: "Pantalla TV" })).toBeVisible()
  await expect(page.getByText("Backend operativo")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1200) // asentar degradados/transiciones
  await page.screenshot({ path: `${OUT}/launcher.png` })
  console.log("✓ launcher.png")

  // ---------------------------------------------------------------- 2) dashboard
  const admin = await ctx.newPage()
  await admin.goto(`${BASE}/?view=admin`)
  await admin.fill("#email", "admin@restaurante.com")
  await admin.fill("#password", "admin123")
  await admin.getByRole("button", { name: "Entrar" }).click()
  await expect(admin.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 })
  await expect(admin.locator('img[src="/logo-mark.svg"]')).toBeVisible() // logo en el sidebar
  await expect(admin.getByText("Realtime conectado")).toBeVisible({ timeout: 20_000 })

  // ---------------------------------------------------------------- 3) TV EN VIVO
  // La TV se abre AHORA (panel ya conectado): su espectador dispara el
  // broadcast stream:server → el Dashboard pasará a EN DIRECTO, y su
  // vinculación a TV-001 lo muestra ONLINE en tiempo real.
  await page.goto(`${BASE}/?view=tv`)
  await page.getByText("Identificar esta pantalla").waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: /TV-001/ }).first().click()
  await page.waitForLoadState("domcontentloaded")
  await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("EN VIVO", { exact: true })).toBeVisible({ timeout: 30_000 })
  // Esperar frames reales de vídeo decodificados
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video")
      return !!v && v.readyState >= 2 && v.currentTime > 1.2
    },
    undefined,
    { timeout: 30_000 }
  )
  await page.waitForTimeout(2500) // frame estable + carrusel asentado
  await page.screenshot({ path: `${OUT}/tv-display.png` })
  console.log("✓ tv-display.png (EN VIVO, vídeo decodificando)")

  // ---------------------------------------------------------------- 4) dashboard (estado vivo)
  // La TV ya está conectada. El watchdog del player reporta métricas cada 5 s:
  // esperar el reporte completo (estado live + resolución) del TV-001.
  await expect(admin.getByText("EN DIRECTO").first()).toBeVisible({ timeout: 20_000 })
  await expect(admin.getByText("1920×1080")).toBeVisible({ timeout: 20_000 })
  await expect(admin.getByText("ONLINE", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await admin.waitForTimeout(1500) // asentar tarjetas, espectadores y estado
  await admin.screenshot({ path: `${OUT}/admin-dashboard.png` })
  console.log("✓ admin-dashboard.png (EN DIRECTO · TV-001 ONLINE)")

  // ---------------------------------------------------------------- 5) transmisión
  await admin.getByRole("button", { name: "Transmisión" }).click()
  await expect(admin.getByText("EN VIVO").first()).toBeVisible({ timeout: 20_000 })
  await admin.waitForTimeout(2500) // métricas de la sesión activa
  await admin.screenshot({ path: `${OUT}/admin-stream.png` })
  console.log("✓ admin-stream.png")

  await browser.close()

  // ------------------------------------------------- 6) post-proceso (assets finales)
  // 3840×2160 (@2x) → 2560×1440: nitidez retina en el README con peso
  // razonable. La TV pasa a JPEG q92 (contenido fotográfico: ~5× más ligera).
  for (const name of ["launcher", "tv-display", "admin-dashboard", "admin-stream"]) {
    await sharp(`${OUT}/${name}.png`)
      .resize(2560, 1440, { kernel: "lanczos3" })
      .toFile(`${OUT}/.tmp-${name}.png`)
    renameSync(`${OUT}/.tmp-${name}.png`, `${OUT}/${name}.png`)
  }
  await sharp(`${OUT}/tv-display.png`).jpeg({ quality: 92 }).toFile(`${OUT}/tv-display.jpg`)
  unlinkSync(`${OUT}/tv-display.png`)
  console.log("✓ post-proceso: PNGs 2560×1440 + tv-display.jpg (q92)")

  console.log("✅ capturas completas")
}

main().catch((err) => {
  console.error("✗ fallo en las capturas:", err)
  process.exit(1)
})
