/**
 * Tests de la autenticación del realtime-service (FASE 5).
 * Funciones puras de mini-services/realtime-service/auth.ts:
 * handshake admin (cookie HMAC + authVersion), pairing de pantallas
 * (sha256), política CORS de orígenes y saneo de payloads.
 */
import { describe, it, expect } from "bun:test"
import { createHmac } from "crypto"
import {
  parseCookie,
  verifySessionToken,
  checkAdminSession,
  checkScreenAuth,
  sha256Hex,
  originAllowed,
  sanitizeForScreens,
  type SessionPayloadShape,
} from "../mini-services/realtime-service/auth"

const SECRET = "test-secret-0123456789abcdef0123456789abcdef"

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url")
}

/** Minta un token con el MISMO formato que src/lib/auth.ts */
function mintToken(payload: Partial<SessionPayloadShape> & { uid: string; exp: number }): string {
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url")
  return `${body}.${sig}`
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600

describe("parseCookie", () => {
  it("extrae la cookie correcta de una cabecera con varias", () => {
    const header = "a=1; signage_session=abc.def; other=x"
    expect(parseCookie(header, "signage_session")).toBe("abc.def")
  })
  it("devuelve null si no existe o no hay cabecera", () => {
    expect(parseCookie(undefined, "x")).toBeNull()
    expect(parseCookie("a=1", "x")).toBeNull()
  })
})

describe("verifySessionToken (handshake admin)", () => {
  it("token válido se verifica y devuelve el payload", () => {
    const t = mintToken({ uid: "u1", email: "a@b.c", name: "A", role: "ADMIN", av: 2, exp: FUTURE })
    const p = verifySessionToken(t, SECRET)
    expect(p).not.toBeNull()
    expect(p!.uid).toBe("u1")
    expect(p!.av).toBe(2)
  })
  it("secreto distinto → null", () => {
    const t = mintToken({ uid: "u1", exp: FUTURE })
    expect(verifySessionToken(t, "otro-secreto-largo-0123456789abcdef")).toBeNull()
  })
  it("token expirado → null", () => {
    const t = mintToken({ uid: "u1", exp: Math.floor(Date.now() / 1000) - 10 })
    expect(verifySessionToken(t, SECRET)).toBeNull()
  })
  it("token malformado → null", () => {
    expect(verifySessionToken("garbage", SECRET)).toBeNull()
    expect(verifySessionToken("a.b.c.d", SECRET)).toBeNull()
  })
})

describe("checkAdminSession (validación contra DB)", () => {
  const payload = { uid: "u1", email: "a@b.c", name: "A", role: "ADMIN", av: 3, exp: FUTURE }
  const user = { id: "u1", role: "ADMIN", active: 1, authVersion: 3 }

  it("usuario activo con authVersion coincidente → identidad ADMIN", () => {
    const id = checkAdminSession(payload, user)
    expect(id).not.toBeNull()
    expect(id!.role).toBe("ADMIN")
  })
  it("usuario deshabilitado → null", () => {
    expect(checkAdminSession(payload, { ...user, active: 0 })).toBeNull()
  })
  it("authVersion distinta (password cambiada) → null", () => {
    expect(checkAdminSession(payload, { ...user, authVersion: 4 })).toBeNull()
  })
  it("usuario inexistente (eliminado) → null", () => {
    expect(checkAdminSession(payload, null)).toBeNull()
  })
  it("uid distinto → null", () => {
    expect(checkAdminSession(payload, { ...user, id: "otro" })).toBeNull()
  })
})

describe("checkScreenAuth (pairing)", () => {
  const token = "mi-token-de-pantalla-32-chars-abcdef"
  const screen = { code: "TV-001", active: 1, tokenHash: sha256Hex(token) }

  it("token correcto → verificada", () => {
    const r = checkScreenAuth("TV-001", token, screen)
    expect(r.ok).toBeTrue()
    expect(r.ok && r.verified).toBeTrue()
  })
  it("token incorrecto → rechazo (anti-suplantación)", () => {
    expect(checkScreenAuth("TV-001", "otro-token", screen)).toEqual({ ok: false, reason: "bad-token" })
  })
  it("sin token cuando la pantalla lo exige → rechazo", () => {
    expect(checkScreenAuth("TV-001", undefined, screen)).toEqual({ ok: false, reason: "bad-token" })
  })
  it("código desconocido → rechazo", () => {
    expect(checkScreenAuth("TV-999", undefined, null)).toEqual({ ok: false, reason: "unknown" })
  })
  it("pantalla inactiva → rechazo", () => {
    expect(checkScreenAuth("TV-001", token, { ...screen, active: 0 })).toEqual({ ok: false, reason: "inactive" })
  })
  it("pantalla sin emparejar (tokenHash null) → aceptada NO verificada (transición)", () => {
    const r = checkScreenAuth("TV-002", undefined, { code: "TV-002", active: 1, tokenHash: null })
    expect(r.ok).toBeTrue()
    expect(r.ok && r.verified).toBeFalse()
  })
})

describe("originAllowed (CORS sin '*')", () => {
  it("orígenes privados de LAN permitidos", () => {
    expect(originAllowed("http://192.168.1.50:3000", undefined)).toBeTrue()
    expect(originAllowed("http://10.0.0.5:81", undefined)).toBeTrue()
    expect(originAllowed("http://localhost:3000", undefined)).toBeTrue()
  })
  it("orígenes públicos DENEGADOS (anti-CSWSH)", () => {
    expect(originAllowed("https://evil.com", undefined)).toBeFalse()
    expect(originAllowed("http://8.8.8.8:3003", undefined)).toBeFalse()
  })
  it("host del handshake propio permitido (aunque sea IP pública del server)", () => {
    expect(originAllowed("http://200.100.50.25:3000", "200.100.50.25:3000")).toBeTrue()
  })
  it("ALLOWED_ORIGINS explícito permitido", () => {
    expect(originAllowed("https://panel.midominio.es", undefined, ["https://panel.midominio.es"])).toBeTrue()
  })
  it("sin Origin (cliente no-navegador) permitido", () => {
    expect(originAllowed(undefined, undefined)).toBeTrue()
  })
  it("origin inválido → denegado", () => {
    expect(originAllowed("no-es-url", undefined)).toBeFalse()
  })
})

describe("sanitizeForScreens (no filtrar info a TVs)", () => {
  it("elimina publisherIp y lastSession, conserva el resto", () => {
    const payload = {
      source: "local",
      live: true,
      viewers: 3,
      publisherIp: "192.168.1.77",
      lastSession: { ip: "192.168.1.77", inBytes: 1 },
      ts: 123,
    }
    const safe = sanitizeForScreens(payload) as Record<string, unknown>
    expect(safe.publisherIp).toBeUndefined()
    expect(safe.lastSession).toBeUndefined()
    expect(safe.live).toBe(true)
    expect(safe.viewers).toBe(3)
    expect(safe.ts).toBe(123)
  })
  it("payload no-objeto pasa tal cual", () => {
    expect(sanitizeForScreens(null)).toBeNull()
    expect(sanitizeForScreens(42)).toBe(42)
  })
})
