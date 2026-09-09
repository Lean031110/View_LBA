/**
 * Tests de INTEGRACIÓN de API (FASE 22) — contra el servidor en marcha.
 *
 * Requiere: servidor corriendo (dev o standalone). URL via APP_URL
 * (default http://127.0.0.1:3000). En CI se levanta standalone antes.
 *
 * Cubre: login (ok/fallo/deshabilitado/inexistente), rate limiting,
 * matriz de permisos VIEWER/OPERATOR/ADMIN, invalidación de sesión por
 * authVersion, CRUD de usuarios/pantallas, validación de settings,
 * uploads (PNG válido/SVG rechazado), endpoints de stream y contenido.
 *
 * ⚠ El servidor de pruebas debe tener seed con usuarios demo; los datos
 * de prueba se crean y limpian dentro de los propios tests.
 */
import { describe, it, expect, beforeAll } from "bun:test"

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000"

let adminCookie = ""
let opCookie = ""

async function api(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; data: unknown; headers: Headers }> {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

function cookieFrom(res: { headers: Headers }): string {
  const set = res.headers.get("set-cookie") ?? ""
  return set.split(";")[0]
}

async function login(email: string, password: string): Promise<{ status: number; cookie: string; data: unknown }> {
  const res = await api("POST", "/api/auth/login", { email, password })
  return { status: res.status, cookie: cookieFrom(res), data: res.data }
}

// FASE 22: estos tests requieren el servidor en marcha (dev o standalone).
// Si no hay servidor (p. ej. `bun test` a solas en CI antes de FASE 24) se
// MARCAN COMO OMITIDOS de forma explícita y visible — nunca se “pasan” sin
// correr. En FASE 24 el CI arranca el servidor y se ejecutan de verdad.
const SERVER_UP = await (async () => {
  try {
    const r = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
})()
if (!SERVER_UP) {
  console.warn(
    `⚠ integration/api.test.ts: sin servidor en ${APP_URL} → tests OMITIDOS ` +
      "(arranca `bun run dev` para ejecutarlos; FASE 24 los integra en CI con servidor real)"
  )
}
const d = (SERVER_UP ? describe : describe.skip) as typeof describe

d("login y sesiones", () => {
  it("login correcto devuelve usuario y cookie httpOnly", async () => {
    const r = await login("admin@restaurante.com", "admin123")
    expect(r.status).toBe(200)
    const d = r.data as { user: { role: string } }
    expect(d.user.role).toBe("ADMIN")
    expect(r.cookie).toContain("signage_session=")
    adminCookie = r.cookie
  })

  it("password incorrecta → 401 genérico", async () => {
    const r = await login("admin@restaurante.com", "incorrecta")
    expect(r.status).toBe(401)
    const d = r.data as { error: string }
    expect(d.error).toBe("Credenciales inválidas")
  })

  it("usuario inexistente → MISMO 401 (no revela existencia)", async () => {
    const r = await login("nadie@nada.com", "loquesea123")
    expect(r.status).toBe(401)
    const d = r.data as { error: string }
    expect(d.error).toBe("Credenciales inválidas")
  })

  it("sin sesión → 401 en /me y endpoints admin", async () => {
    expect((await api("GET", "/api/auth/me")).status).toBe(401)
    expect((await api("GET", "/api/admin/users")).status).toBe(401)
  })

  it("logout limpia la cookie", async () => {
    const r = await api("POST", "/api/auth/logout", {}, adminCookie)
    expect(r.status).toBe(200)
    expect(cookieFrom(r)).toBe("signage_session=")
    // re-login para los siguientes tests
    const re = await login("admin@restaurante.com", "admin123")
    adminCookie = re.cookie
  })
})

d("rate limiting de login (brute force)", () => {
  it("múltiples fallos → 429 con bloqueo", async () => {
    const email = "bruteforce-int@test.local"
    let last = 0
    for (let i = 0; i < 6; i++) {
      const r = await login(email, "clave-mala-" + i)
      last = r.status
    }
    expect(last).toBe(429)
    // login correcto también bloqueado durante cooldown (por cuenta)
    const ok = await login(email, "cualquiera")
    expect(ok.status).toBe(429)
  })
})

d("autorización (matriz de roles)", () => {
  beforeAll(async () => {
    const r = await login("operador@restaurante.com", "operador123")
    opCookie = r.cookie
    expect(r.status).toBe(200)
  })

  it("operator puede escribir settings; streamKey por esa vía → 400", async () => {
    expect((await api("PUT", "/api/admin/settings", { tickerSpeed: 55 }, opCookie)).status).toBe(200)
    const bad = await api("PUT", "/api/admin/settings", { streamKey: "hack" }, opCookie)
    expect(bad.status).toBe(400)
  })

  it("operator NO puede gestionar usuarios (403)", async () => {
    expect((await api("GET", "/api/admin/users", undefined, opCookie)).status).toBe(403)
    expect((await api("POST", "/api/admin/users", { email: "x@x.x", name: "x", role: "VIEWER", password: "Clave123456" }, opCookie)).status).toBe(403)
  })

  it("operator NO puede regenerar clave de stream (403)", async () => {
    expect((await api("POST", "/api/admin/stream/rtmp", {}, opCookie)).status).toBe(403)
  })
})

d("usuarios: política, authVersion y último admin", () => {
  it("crear usuario con contraseña débil → 400", async () => {
    const r = await api("POST", "/api/admin/users", { email: "debil@test.local", name: "D", role: "VIEWER", password: "admin123" }, adminCookie)
    expect(r.status).toBe(400)
    expect((r.data as { field?: string }).field).toBe("password")
  })

  it("cambio de password invalida la sesión anterior (authVersion)", async () => {
    // crear viewer de prueba
    const create = await api("POST", "/api/admin/users", { email: "invalidate@test.local", name: "Inv", role: "VIEWER", password: "Clave123456" }, adminCookie)
    expect(create.status).toBe(200)
    const id = (create.data as { item: { id: string } }).item.id

    // login → sesión válida
    const s = await login("invalidate@test.local", "Clave123456")
    expect(s.status).toBe(200)
    expect((await api("GET", "/api/auth/me", undefined, s.cookie)).status).toBe(200)

    // admin cambia la password → authVersion++
    const upd = await api("PUT", `/api/admin/users/${id}`, { password: "NuevaClave789" }, adminCookie)
    expect(upd.status).toBe(200)

    // la sesión vieja muere al instante
    expect((await api("GET", "/api/auth/me", undefined, s.cookie)).status).toBe(401)

    // login con la nueva funciona
    expect((await login("invalidate@test.local", "NuevaClave789")).status).toBe(200)

    // limpieza
    await api("DELETE", `/api/admin/users/${id}`, undefined, adminCookie)
  })

  it("no se puede eliminar al último admin activo", async () => {
    const users = await api("GET", "/api/admin/users", undefined, adminCookie)
    const admins = (users.data as { items: { id: string; email: string; role: string; active: boolean }[] }).items.filter((u) => u.role === "ADMIN" && u.active)
    // en el seed hay un solo admin: intentar eliminarlo → 400
    if (admins.length === 1 && admins[0].email === "admin@restaurante.com") {
      const del = await api("DELETE", `/api/admin/users/${admins[0].id}`, undefined, adminCookie)
      expect(del.status).toBe(400)
    }
  })
})

d("validación de datos (FASE 9 en integración)", () => {
  it("settings: volume -500 → 400 con campo", async () => {
    const r = await api("PUT", "/api/admin/settings", { audioVolume: -500 }, adminCookie)
    expect(r.status).toBe(400)
    expect((r.data as { field: string }).field).toBe("audioVolume")
  })

  it("promoción con javascript: URL → 400", async () => {
    const r = await api("POST", "/api/admin/promotions", { title: "X", duration: 10, imageUrl: "javascript:alert(1)" }, adminCookie)
    expect(r.status).toBe(400)
  })

  it("pantalla con código inválido → 400", async () => {
    const r = await api("POST", "/api/admin/screens", { code: "tv malo", name: "X" }, adminCookie)
    expect(r.status).toBe(400)
  })
})

d("endpoints públicos", () => {
  it("/api/health (FASE 25): 200, DB viva, sin secretos", async () => {
    const r = await api("GET", "/api/health")
    // este job solo levanta la app (sin mini-servicios) → ok|degraded, NUNCA
    // unhealthy (la DB debe estar viva) y siempre 200 en ese rango
    expect(r.status).toBe(200)
    const d = r.data as { status: string; database: { ok: boolean }; realtime: { ok: boolean }; stream: { ok: boolean } }
    expect(["ok", "degraded"]).toContain(d.status)
    expect(d.database.ok).toBeTrue()
    // sin mini-servicios en este entorno → degraded por realtime/stream caídos
    expect(d.realtime.ok).toBeFalse()
    expect(d.stream.ok).toBeFalse()
    // sin secretos en la respuesta
    expect(JSON.stringify(r.data)).not.toContain("streamKey")
    expect(JSON.stringify(r.data)).not.toContain("AUTH_SECRET")
  })

  it("/api/content: bundle sin streamKey", async () => {
    const r = await api("GET", "/api/content")
    expect(r.status).toBe(200)
    const d = r.data as { settings: Record<string, unknown>; screens: unknown[] }
    expect(d.settings).not.toHaveProperty("streamKey")
    expect(d.settings).not.toHaveProperty("streamServer")
    expect(Array.isArray(d.screens)).toBeTrue()
  })

  it("/api/stream/status: mínimo (sin viewers/since)", async () => {
    const r = await api("GET", "/api/stream/status")
    expect(r.status).toBe(200)
    const d = r.data as Record<string, unknown>
    expect(d).toHaveProperty("live")
    expect(d).toHaveProperty("serverOk")
    expect(d).not.toHaveProperty("viewers")
    expect(d).not.toHaveProperty("since")
    expect(d).not.toHaveProperty("publisherIp")
  })
})

d("uploads (FASE 10 en integración)", () => {
  it("PNG real se acepta; SVG se rechaza; servido con nosniff", async () => {
    // PNG mínimo válido
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ])
    const fd = new FormData()
    fd.append("file", new File([png], "test.png", { type: "image/png" }))
    const up = await fetch(`${APP_URL}/api/upload`, { method: "POST", headers: { cookie: adminCookie }, body: fd })
    expect(up.status).toBe(200)
    const upData = (await up.json()) as { url: string }
    expect(upData.url).toStartWith("/api/files/")

    // el archivo se sirve con nosniff
    const served = await fetch(`${APP_URL}${upData.url}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")

    // SVG rechazado
    const fd2 = new FormData()
    fd2.append("file", new File([Buffer.from("<svg><script>alert(1)</script></svg>")], "evil.svg", { type: "image/svg+xml" }))
    const up2 = await fetch(`${APP_URL}/api/upload`, { method: "POST", headers: { cookie: adminCookie }, body: fd2 })
    expect(up2.status).toBe(400)
  })
})

d("stream-test SSRF (FASE 12 en integración)", () => {
  it("URL interna → 400 bloqueado", async () => {
    const r = await api("POST", "/api/admin/stream-test", { url: "http://127.0.0.1:8100/status" }, adminCookie)
    expect(r.status).toBe(400)
    expect((r.data as { error: string }).error).toContain("SSRF")
  })
})
