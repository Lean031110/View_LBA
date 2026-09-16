/**
 * manual-screenshots.ts — capturas REALES del sistema para el Manual de
 * Usuario (PDF §27: «si existen screenshots reales, utilizarlos»).
 *
 * Requisitos (stack en marcha): web :3000 (build standalone, DB e2e),
 * realtime :3003/:3004, stream :1935/:8100 con publicación RTMP activa.
 *
 * Salidas (docs/manual/assets/):
 *   · login.png             — pantalla de acceso a Administración
 *   · admin-themes.png      — gestor de Temas de Pantalla (licencia activa)
 *   · admin-license.png     — sección Licencia (estado + fechas + días)
 *   · tv-default.png        — pantalla TV con tema ViewLBA Default (EN VIVO)
 *   · tv-classic.png        — pantalla TV con tema ViewLBA Classic
 *   · tv-neon.png           — pantalla TV con tema ViewLBA Neon
 *
 * Al terminar restaura el tema Default (estado limpio).
 */
import { chromium } from "@playwright/test"
import { openE2eRequestCode } from "../e2e/fixtures/licensing/license-builder"
import { E2E_LICENSE_PRIVATE_KEY } from "../e2e/fixtures/licensing/keys"
import { buildLicenseToken } from "../src/lib/licensing/token"

const BASE = "http://127.0.0.1:3000"
const OUT = "docs/manual/assets"
const ADMIN = { email: "admin@restaurante.com", password: "admin123" }

async function apiLogin(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  })
  if (!res.ok) throw new Error(`apiLogin falló (${res.status})`)
  return (res.headers.get("set-cookie") ?? "").split(";")[0]
}

/**
 * Asegura licencia ACTIVA con el flujo REAL del cliente (request-code →
 * token → activate) — contra la identidad de ESTE servidor. El servidor de
 * capturas usa las claves públicas DUMMY de E2E, por lo que el token lo
 * firmamos con la clave DUMMY de test (sin secretos reales).
 */
async function ensureActiveLicense(cookie: string): Promise<void> {
  const st = (await fetch(`${BASE}/api/license`, { headers: { cookie } }).then((r) => r.json())) as {
    status?: string
  }
  if (st?.status === "active") {
    console.log("  licencia ya activa")
    return
  }
  // 1. código de solicitud del SERVIDOR (identidad real de esta máquina)
  const rc = (await fetch(`${BASE}/api/license/request-code`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "La Terraza Grill & Bar" }),
  }).then((r) => r.json())) as {
    requestCode?: string
  }
  if (!rc?.requestCode) throw new Error("request-code falló: " + JSON.stringify(rc).slice(0, 200))
  // 2. el "emisor" (claves DUMMY de E2E) abre el código y emite el token
  const opened = openE2eRequestCode(rc.requestCode as string)
  const token = buildLicenseToken(
    {
      v: 2,
      licenseId: "VLBA-0badc0ffee01",
      customerName: "La Terraza Grill & Bar",
      plan: "annual",
      durationDays: 365,
      product: "ViewLBA-Server",
      issuedAt: Date.now(),
      startsAt: Date.now(),
      expiresAt: Date.now() + 365 * 86400000,
      installationId: opened.payload.installationId,
      diskId: opened.payload.diskId,
      features: {
        "display.watermark": false,
        "screens.multiDisplay": true,
        "branding.customLogo": true,
        "themes.custom": true,
        "users.management": true,
        "backup.selfService": true,
        "analytics.advanced": true,
      },
      nonce: "0123456789abcdef0123456789abcdef",
    },
    E2E_LICENSE_PRIVATE_KEY
  )
  // 3. activar (el servidor revalida firma + binding de ESTA máquina)
  const act = (await fetch(`${BASE}/api/license/activate`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).then((r) => r.json())) as {
    ok?: boolean
  }
  if (!act?.ok) throw new Error("activate falló: " + JSON.stringify(act).slice(0, 200))
  console.log("  licencia activada para la identidad de esta máquina")
}

async function activateTheme(cookie: string, themeId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/admin/themes/${themeId}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "activate" }),
  })
  if (!res.ok) throw new Error(`activateTheme(${themeId}) falló (${res.status})`)
}

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "es-ES",
    timezoneId: "America/Havana",
  })
  const page = await ctx.newPage()
  const cookie = await apiLogin()
  await ensureActiveLicense(cookie)

  // ------------------------------------------------------------- 1) login
  await page.goto(`${BASE}/?view=admin`)
  await page.locator("#email").waitFor({ timeout: 30_000 })
  await page.fill("#email", ADMIN.email)
  await page.fill("#password", ADMIN.password)
  await page.screenshot({ path: `${OUT}/login.png` })
  console.log("✓ login.png")

  // --------------------------------------------------- 2) panel: Temas
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 30_000 })
  await page.getByRole("button", { name: "Temas de Pantalla" }).click()
  await page.getByRole("heading", { name: "Temas de Pantalla" }).waitFor()
  await page.getByText("Tema activo:").first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1200) // asentar mini-maqueta de preview
  await page.screenshot({ path: `${OUT}/admin-themes.png` })
  console.log("✓ admin-themes.png")

  // --------------------------------------------- 3) panel: Licencia
  await page.getByRole("button", { name: "Licencia", exact: true }).click()
  await page.getByRole("heading", { name: "Licencia" }).waitFor()
  await page.getByText("LICENCIA ACTIVA").first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/admin-license.png` })
  console.log("✓ admin-license.png")

  // ------------------------------------------------- 4) TV por tema
  const tv = await ctx.newPage()
  // la TV se VINCULA a TV-001 (identidad real → recibe eventos realtime §15)
  await tv.goto(`${BASE}/?view=tv`)
  const picker = tv.getByText("Identificar esta pantalla")
  try {
    await picker.waitFor({ state: "visible", timeout: 15_000 })
    await tv.getByRole("button", { name: /TV-001/ }).first().click()
    await tv.getByText("La Terraza Grill & Bar").first().waitFor({ timeout: 30_000 })
  } catch {
    /* ya tiene identidad: cerrar el selector si apareció */
    try {
      await tv.getByRole("button", { name: "Cerrar" }).click()
    } catch {}
    await tv.getByText("La Terraza Grill & Bar").first().waitFor({ timeout: 30_000 })
  }
  // esperar a que el reproductor pase a EN VIVO (publicador RTMP activo)
  await tv.waitForTimeout(6000)

  for (const [themeId, file, label] of [
    ["default", "tv-default.png", "ViewLBA Default"],
    ["viewlba-classic", "tv-classic.png", "ViewLBA Classic"],
    ["viewlba-neon", "tv-neon.png", "ViewLBA Neon"],
  ] as const) {
    await activateTheme(cookie, themeId)
    // §15: la TV recibe el cambio por realtime (sin recarga) — esperar a que
    // el fondo del tema correspondiente esté presente
    if (themeId === "default") {
      await tv.locator(".tv-theme-bg").waitFor({ state: "hidden", timeout: 25_000 })
    } else {
      await tv.locator(`.tv-theme-bg[data-theme-bg='${themeId === "viewlba-classic" ? "gradient" : "glow"}']`).waitFor({ state: "visible", timeout: 25_000 })
    }
    await tv.waitForTimeout(2500) // asentar animaciones/Ken Burns
    await tv.screenshot({ path: `${OUT}/${file}` })
    console.log(`✓ ${file} (${label})`)
  }

  // ------------------------------------------------- 5) estado limpio
  await activateTheme(cookie, "default")
  await browser.close()
  console.log("✅ capturas completas (tema restaurado a Default)")
}

main().catch((e) => {
  console.error("✗", e)
  process.exit(1)
})
