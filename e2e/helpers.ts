/**
 * Helpers E2E (FASE 22) — compartidos por todos los specs.
 *
 * Requisitos del stack (playwright.config.ts webServer):
 *   · app Next.js en http://127.0.0.1:3000
 *   · realtime-service en :3003 (socket) / :3004 (API interna /status)
 *   · stream-service en :1935 (RTMP) / :8100 (control)
 *   · DB e2e con seed demo (scripts/e2e-setup.ts)
 */
import { expect, type Page, type Browser } from "@playwright/test"
import { spawn, type ChildProcess } from "child_process"

export const RT_INTERNAL = "http://127.0.0.1:3004"
export const STREAM_CONTROL = "http://127.0.0.1:8100"
export const STREAM_KEY = "e2e-stream-key-0123456789"

// ---------------------------------------------------------------- credenciales
export const ADMIN = { email: "admin@restaurante.com", password: "admin123" }
export const OPERATOR = { email: "operador@restaurante.com", password: "operador123" }
export const VIEWER = { email: "viewer@restaurante.com", password: "Viewer12345" }

// ---------------------------------------------------------------- login/logout
/** Login por UI y espera del dashboard (sidebar visible). */
export async function login(page: Page, creds: { email: string; password: string }): Promise<void> {
  await page.goto("/?view=admin")
  await page.fill("#email", creds.email)
  await page.fill("#password", creds.password)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 })
}

/** Login por API (Node fetch) → cookie de sesión para llamadas administrativas. */
export async function apiLogin(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  })
  if (!res.ok) throw new Error(`apiLogin falló (${res.status})`)
  const setCookie = res.headers.get("set-cookie") ?? ""
  return setCookie.split(";")[0]
}

/** Login por UI esperando el error genérico (no revela existencia del usuario). */
export async function loginExpectingError(page: Page, creds: { email: string; password: string }): Promise<void> {
  await page.goto("/?view=admin")
  await page.fill("#email", creds.email)
  await page.fill("#password", creds.password)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page.getByText("Credenciales inválidas")).toBeVisible()
}

/** Contexto+page independientes con una sesión iniciada (para escenarios multi-sesión). */
export async function loggedInPage(browser: Browser, creds: { email: string; password: string }): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await login(page, creds)
  return page
}

// ---------------------------------------------------------------- realtime /status
export interface RtScreen {
  screenCode: string
  online?: boolean
  streamState?: string
  audioInfo?: { devices?: unknown[] } | null
}

export async function realtimeStatus(): Promise<{ ok: boolean; screens: RtScreen[] }> {
  const res = await fetch(`${RT_INTERNAL}/status`, { cache: "no-store" })
  return (await res.json()) as { ok: boolean; screens: RtScreen[] }
}

/** Espera determinista del estado de una pantalla en el servicio realtime. */
export async function waitForScreen(
  code: string,
  want: { online: boolean; streamState?: string },
  timeoutMs = 25_000
): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const st = await realtimeStatus()
    const entry = st.screens.find((s) => s.screenCode === code)
    const onlineOk = want.online ? entry?.online === true : !entry || entry.online !== true
    const stateOk = want.streamState === undefined || entry?.streamState === want.streamState
    if (entry && onlineOk && stateOk) return
    if (!entry && !want.online && want.streamState === undefined) return
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `waitForScreen(${code}, ${JSON.stringify(want)}) timeout — /status: ${JSON.stringify(
          st.screens.map((s) => [s.screenCode, s.online, s.streamState])
        )}`
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ---------------------------------------------------------------- TV display
/** Abre la TV, cierra el selector de identidad inicial y espera el contenido. */
export async function openTv(page: Page): Promise<void> {
  await page.goto("/?view=tv")
  // Primera visita → selector de identidad; cerrarlo (contenido queda visible detrás)
  const picker = page.getByText("Identificar esta pantalla")
  try {
    await picker.waitFor({ state: "visible", timeout: 15_000 })
    await page.getByRole("button", { name: "Cerrar" }).click()
  } catch {
    // ya tiene identidad elegida (localStorage) — sin selector
  }
  // El contenido carga: nombre del restaurante en el header
  await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })
}

/** Abre la TV y la vincula a una pantalla concreta (selector de identidad). */
export async function bindTvScreen(page: Page, code: string): Promise<void> {
  await page.goto("/?view=tv")
  await page.getByText("Identificar esta pantalla").waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: new RegExp(code) }).first().click()
  // handleSelectScreen → localStorage + window.location.reload()
  await page.waitForLoadState("domcontentloaded")
  await expect(page.getByText("La Terraza Grill & Bar").first()).toBeVisible({ timeout: 30_000 })
}

// ---------------------------------------------------------------- stream status
export async function publicStreamStatus(): Promise<{
  source: string
  streamEnabled: boolean
  serverOk: boolean
  live: boolean | null
}> {
  const res = await fetch("http://127.0.0.1:3000/api/stream/status", { cache: "no-store" })
  return (await res.json()) as { source: string; streamEnabled: boolean; serverOk: boolean; live: boolean | null }
}

/**
 * Publicador RTMP de prueba (FASE 23 lo reutiliza): ffmpeg con fuente sintética.
 * OBS real usa el mismo protocolo — ffmpeg es el "OBS de CI".
 */
export function startRtmpPublisher(key = STREAM_KEY): ChildProcess {
  return spawn(
    "ffmpeg",
    [
      "-loglevel", "error",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "96k",
      "-f", "flv",
      `rtmp://127.0.0.1:1935/live/${key}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
}

export function stopPublisher(proc: ChildProcess | null): void {
  if (!proc || proc.exitCode !== null) return
  proc.kill("SIGINT") // corte limpio (como parar OBS)
  // dar tiempo al aviso donePublish antes de SIGKILL
  const t = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, 3000)
  t.unref?.()
}

// ---------------------------------------------------------------- PNG de prueba
/** PNG 1x1 válido (magic bytes reales — pasa la validación de uploads). */
export function tinyPng(): Buffer {
  // 1x1 RGBA negro; estructura PNG completa y CRCs correctos
  const buf = Buffer.alloc(67)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  sig.copy(buf, 0)
  const ihdr = Buffer.from([
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
  ])
  ihdr.copy(buf, 8)
  const idat = Buffer.from([
    0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xf7,
  ])
  idat.copy(buf, 33)
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  iend.copy(buf, 57)
  return buf
}
