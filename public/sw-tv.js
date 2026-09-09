/**
 * Service Worker de la PANTALLA TV (FASE 34 — offline/PWA).
 *
 * Objetivo (misión): la TV debe sobrevivir a una RECARGA/reinicio con el
 * servidor caído — sin este shell, el navegador no puede cargar ni la app
 * (pantalla vacía). Estrategias:
 *
 *  · /_next/static/* + iconos/logo + manifest  → cache-first (assets con
 *    hash de contenido: inmutables) con revalidación en segundo plano.
 *  · Navegación (documento HTML)               → network-first con fallback
 *    al shell cacheado (la TV arranca offline con el último HTML válido).
 *  · /api/content                              → network-first con fallback
 *    a la última respuesta cacheada (el ÚLTIMO contenido conocido: promos,
 *    platos, horarios, ticker, branding, programación).
 *  · /api/stream/status                        → network-only passthrough
 *    (estado vivo; nunca se cachea).
 *  · NUNCA se cachea: /api/admin/*, /api/auth/*, /api/upload, /api/files/*
 *    (datos privados del admin — passthrough; fallarán offline, que es lo
 *    correcto) ni el stream .flv (streaming en vivo, no cacheable).
 *
 * Registro: solo la vista TV lo registra (TvDisplay, NODE_ENV=production)
 * — el panel admin NO usa este SW (no cachea nada del admin).
 */

const CACHE = "viewlba-tv-v1"
const SHELL_ASSETS = ["/logo.svg", "/logo-mark.svg", "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  // limpiar caches viejas al activar
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/** ¿Petición que NUNCA debe tocarse desde el SW? (privada o streaming) */
function neverTouch(pathname) {
  return (
    pathname.startsWith("/api/admin/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/upload") ||
    pathname.startsWith("/api/files/") ||
    pathname.endsWith(".flv")
  )
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    // revalidación en segundo plano (stale-while-revalidate)
    fetch(request)
    .then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res))
    })
    .catch(() => {})
    return cached
  }
  const res = await fetch(request)
  if (res && res.ok) {
    const c = await caches.open(CACHE)
    c.put(request, res.clone())
  }
  return res
}

async function networkFirst(request, { timeoutMs = 4000 } = {}) {
  try {
    const res = await fetch(request, { signal: AbortSignal.timeout(timeoutMs) })
    if (res && res.ok) {
      const c = await caches.open(CACHE)
      c.put(request, res.clone())
    }
    return res
  } catch (e) {
    const cached = await caches.match(request)
    if (cached) return cached
    // sin red y sin cache → respuesta sintética 503 (la UI ya sabe qué hacer)
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Offline-Fallback": "1" },
    })
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request
  const url = new URL(req.url)

  // solo mismo origen; solo GET (el resto de métodos nunca se cachea)
  if (url.origin !== self.location.origin || req.method !== "GET") return
  if (neverTouch(url.pathname)) return // privado/streaming: passthrough

  // App shell con hash (JS/CSS/fonts de Next) → cache-first
  if (url.pathname.startsWith("/_next/static/") || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(req))
    return
  }

  // Bundle público de la TV → network-first con último-conocido como fallback
  if (url.pathname === "/api/content") {
    event.respondWith(networkFirst(req, { timeoutMs: 4000 }))
    return
  }

  // Navegación (documento) → network-first con shell cacheado como fallback
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, { timeoutMs: 6000 }))
    return
  }

  // estado del stream y demás: red directa (sin cache, sin fallback)
})
