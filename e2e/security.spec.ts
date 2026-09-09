/**
 * E2E FASE 35 — API security final: headers globales, cache de rutas
 * privadas, CORS del stream, stub de /api.
 */
import { test, expect } from "@playwright/test"

test.describe("#35 API security", () => {
  test("headers de seguridad globales en páginas", async ({ request }) => {
    const res = await request.get("/?view=tv")
    expect(res.status()).toBe(200)
    const h = res.headers()
    expect(h["x-content-type-options"]).toBe("nosniff")
    expect(h["x-frame-options"]).toBe("SAMEORIGIN")
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin")
    expect(h["permissions-policy"]).toContain("camera=()")
    const csp = h["content-security-policy"] ?? ""
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain("connect-src 'self' ws: wss:") // realtime en otro puerto
    expect(csp).toContain("media-src 'self' blob:") // pipeline MSE de mpegts.js
  })

  test("APIs privadas nunca cacheables (middleware de headers)", async ({ request }) => {
    const me = await request.get("/api/auth/me")
    expect(me.status()).toBe(401) // sin sesión
    expect((me.headers()["cache-control"] ?? "")).toContain("no-store")
  })

  test("la raíz /api no expone nada (404, sin stub)", async ({ request }) => {
    const res = await request.get("/api")
    expect(res.status()).toBe(404)
  })

  test("el proxy FLV NO abre CORS (same-origin only)", async ({ page }) => {
    await page.goto("/?view=tv", { waitUntil: "domcontentloaded" })
    // Nota: puede haber publicador activo (stream.spec justo antes, ventana
    // de gracia de NMS) → 200 con stream INFINITO. Abortar tras las cabeceras
    // para no descargar el body eterno; 503 también es válido (sin publicador).
    const info = await page.evaluate(async () => {
      const ac = new AbortController()
      const res = await fetch("/api/stream/live.flv", { signal: ac.signal })
      const out = {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        cors: res.headers.get("access-control-allow-origin"),
        csp: res.headers.get("content-security-policy") ?? "",
      }
      ac.abort()
      return out
    })
    expect([200, 503]).toContain(info.status)
    expect(info.cors).toBeNull() // SIN Access-Control-Allow-Origin
    // 200 = flujo FLV; 503 = JSON de "no disponible"
    if (info.status === 200) expect(info.contentType).toContain("video/x-flv")
    else expect(info.contentType).toContain("application/json")
    // el middleware/headers globales también protegen esta ruta
    expect(info.csp).toContain("default-src 'self'")
  })

  test("cookie de sesión: HttpOnly + SameSite=Lax (Secure solo https)", async ({ request }) => {
    const res = await request.post("/api/auth/login", {
      data: { email: "admin@restaurante.com", password: "admin123" },
    })
    expect(res.status()).toBe(200)
    const setCookie = (res.headers()["set-cookie"] ?? "").toLowerCase()
    expect(setCookie).toContain("httponly")
    expect(setCookie).toContain("samesite=lax")
    // bajo http (LAN) NO debe llevar Secure (rompería el login de las TVs/admin)
    expect(setCookie).not.toContain("Secure")
  })
})

test.describe("#37 cache ETag de /api/content", () => {
  test("revalidación condicional → 304 sin re-serializar el bundle", async ({ request }) => {
    const r1 = await request.get("/api/content")
    expect(r1.status()).toBe(200)
    const etag = r1.headers()["etag"]
    expect(etag).toMatch(/^"c-[0-9a-f]{20}"$/)
    expect(r1.headers()["cache-control"]).toContain("no-cache")

    // petición condicional (la que emite el HTTP cache de la TV al revalidar)
    const r2 = await request.get("/api/content", { headers: { "If-None-Match": etag } })
    expect(r2.status()).toBe(304)
    expect(r2.headers()["etag"]).toBe(etag)

    // ETag distinto (o ausente) → respuesta completa, no 304
    const r3 = await request.get("/api/content", { headers: { "If-None-Match": '"c-00000000000000000000"' } })
    expect(r3.status()).toBe(200)
  })
})
