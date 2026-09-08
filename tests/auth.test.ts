/**
 * Tests de autenticación y sesiones (FASE 2 de la misión).
 * Cubre: emisión/verificación de token con authVersion, expiración,
 * invalidación por cambio de password/rol/active (authVersion mismatch),
 * usuario deshabilitado/eliminado, y tokens de formato antiguo (pre-av).
 */
import { describe, it, expect, beforeAll } from "bun:test"

// Entorno válido para los módulos que usan getEnv()
process.env.AUTH_SECRET ??= "test-secret-0123456789abcdef0123456789abcdef"
process.env.REALTIME_TOKEN ??= "test-rt-token-0123456789abcdef"
process.env.DATABASE_URL ??= "file:./test-env.db"

let auth: typeof import("@/lib/auth")

beforeAll(async () => {
  auth = await import("@/lib/auth")
})

const BASE = { uid: "u1", email: "a@b.c", name: "A", role: "ADMIN" as const }

describe("signSession / verifySessionToken", () => {
  it("roundtrip: token con authVersion se verifica y conserva el payload", () => {
    const token = auth.signSession({ ...BASE, av: 3 })
    const payload = auth.verifySessionToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.uid).toBe("u1")
    expect(payload!.av).toBe(3)
    expect(payload!.role).toBe("ADMIN")
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("token expirado es rechazado", () => {
    const token = auth.signSession({ ...BASE, av: 0 }, -1) // TTL negativo → ya expirado
    expect(auth.verifySessionToken(token)).toBeNull()
  })

  it("firma manipulada es rechazada", () => {
    const token = auth.signSession({ ...BASE, av: 0 })
    const [body, sig] = token.split(".")
    const tampered = `${body}.${sig.slice(0, -2)}xx`
    expect(auth.verifySessionToken(tampered)).toBeNull()
  })

  it("payload manipulado (av alterado) invalida la firma", () => {
    const token = auth.signSession({ ...BASE, av: 1 })
    const [body, sig] = token.split(".")
    const payload = JSON.parse(Buffer.from(body, "base64url").toString())
    payload.av = 99
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`
    expect(auth.verifySessionToken(forged)).toBeNull()
  })
})

describe("checkSessionAgainstUser (invalidación de sesiones)", () => {
  const user = { id: "u1", role: "ADMIN", active: true, authVersion: 0 }
  const payload = { ...BASE, av: 0, exp: Math.floor(Date.now() / 1000) + 3600 }

  it("usuario válido con authVersion coincidente → sesión válida", () => {
    expect(auth.checkSessionAgainstUser(payload, user)).toBeTrue()
  })

  it("authVersion distinta (password/rol/active cambió) → sesión INVÁLIDA", () => {
    expect(auth.checkSessionAgainstUser(payload, { ...user, authVersion: 1 })).toBeFalse()
  })

  it("usuario deshabilitado → sesión INVÁLIDA", () => {
    expect(auth.checkSessionAgainstUser(payload, { ...user, active: false })).toBeFalse()
  })

  it("usuario eliminado (null) → sesión INVÁLIDA", () => {
    expect(auth.checkSessionAgainstUser(payload, null)).toBeFalse()
  })

  it("uid distinto → sesión INVÁLIDA", () => {
    expect(auth.checkSessionAgainstUser(payload, { ...user, id: "otro" })).toBeFalse()
  })

  it("token de formato ANTIGUO (sin av) → sesión inválida tras el despliegue", () => {
    // Simula un token emitido antes de FASE 2: no trae authVersion
    const oldPayload = { ...payload, av: undefined as unknown as number }
    expect(auth.checkSessionAgainstUser(oldPayload, user)).toBeFalse()
  })

  it("rol fresco de DB ≠ rol del token: la sesión sigue válida (rol se corrige aparte)", () => {
    // El rol del token está obsoleto pero el mecanismo de validación no depende del rol;
    // getSessionUser() lo reemplaza por el de la DB (fuente de verdad).
    const payloadViewer = { ...payload, role: "VIEWER" as const }
    const userAdmin = { ...user, role: "ADMIN" }
    expect(auth.checkSessionAgainstUser(payloadViewer, userAdmin)).toBeTrue()
  })
})

describe("passwords (scrypt)", () => {
  it("hash/verify roundtrip", () => {
    const h = auth.hashPassword("MiClave123!")
    expect(auth.verifyPassword("MiClave123!", h)).toBeTrue()
    expect(auth.verifyPassword("otra", h)).toBeFalse()
  })

  it("cada hash tiene salt único (dos hashes del mismo password difieren)", () => {
    const a = auth.hashPassword("clave")
    const b = auth.hashPassword("clave")
    expect(a).not.toBe(b)
  })
})
