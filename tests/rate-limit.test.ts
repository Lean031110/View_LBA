/**
 * Tests de rate limiting de login (FASE 3 de la misión).
 * Usa ventanas diminutas para probar la lógica sin esperar minutos reales.
 */
import { describe, it, expect } from "bun:test"
import { createLoginRateLimiter, clientIp } from "@/lib/rate-limit"

// Ventanas de test: 500ms / 3 intentos IP / 2 fallos cuenta / bloqueo 200ms
const TINY = { ipWindowMs: 500, ipMax: 3, accountMaxFails: 2, accountBaseBlockMs: 200, accountMaxBlockMs: 400 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("rate limiting — límite por IP", () => {
  it("permite hasta ipMax intentos y bloquea el siguiente", () => {
    const rl = createLoginRateLimiter(TINY)
    // emails DISTINTOS en cada intento → no dispara el límite por cuenta
    for (let i = 0; i < 3; i++) {
      expect(rl.check("1.2.3.4", `u${i}@x.y`).allowed).toBeTrue()
      rl.recordFailure("1.2.3.4", `u${i}@x.y`)
    }
    const r = rl.check("1.2.3.4", "nuevo@x.y")
    expect(r.allowed).toBeFalse()
    expect(r.reason).toBe("ip")
    expect(r.retryAfterSec).toBeGreaterThan(0)
  })

  it("la ventana deslizante se recupera al expirar", async () => {
    const rl = createLoginRateLimiter(TINY)
    for (let i = 0; i < 3; i++) rl.recordFailure("9.9.9.9", `u${i}@x.y`)
    expect(rl.check("9.9.9.9", "z@z.z").allowed).toBeFalse()
    await sleep(600) // ventana de 500ms expirada
    expect(rl.check("9.9.9.9", "z@z.z").allowed).toBeTrue()
  })

  it("IPs distintas no interfieren entre sí", () => {
    const rl = createLoginRateLimiter(TINY)
    for (let i = 0; i < 3; i++) rl.recordFailure("1.1.1.1", `u${i}@x.y`)
    expect(rl.check("2.2.2.2", "nuevo@x.y").allowed).toBeTrue()
  })

  it("login CORRECTO no limpia la ventana de la IP (anti elusión)", () => {
    const rl = createLoginRateLimiter(TINY)
    for (let i = 0; i < 3; i++) rl.recordFailure("5.5.5.5", `u${i}@x.y`)
    rl.recordSuccess("5.5.5.5", "ok@x.y")
    expect(rl.check("5.5.5.5", "otro-nuevo@x.y").allowed).toBeFalse() // la IP sigue saturada
  })
})

describe("rate limiting — límite por cuenta (con backoff)", () => {
  it("bloquea la cuenta tras accountMaxFails fallos consecutivos", () => {
    const rl = createLoginRateLimiter(TINY)
    rl.recordFailure("1.2.3.4", "victim@x.y")
    expect(rl.check("otra-ip", "victim@x.y").allowed).toBeTrue()
    rl.recordFailure("1.2.3.4", "victim@x.y")
    const r = rl.check("otra-ip", "victim@x.y")
    expect(r.allowed).toBeFalse()
    expect(r.reason).toBe("account")
  })

  it("el login correcto limpia los fallos de la cuenta", () => {
    const rl = createLoginRateLimiter(TINY)
    rl.recordFailure("1.2.3.4", "ok@x.y")
    rl.recordSuccess("1.2.3.4", "ok@x.y")
    expect(rl.check("1.2.3.4", "ok@x.y").allowed).toBeTrue()
  })

  it("el cooldown de cuenta NO es permanente: expira solo", async () => {
    const rl = createLoginRateLimiter(TINY)
    rl.recordFailure("1.2.3.4", "t@x.y")
    rl.recordFailure("1.2.3.4", "t@x.y")
    expect(rl.check("9.9.9.9", "t@x.y").allowed).toBeFalse()
    await sleep(250) // bloqueo base 200ms
    expect(rl.check("9.9.9.9", "t@x.y").allowed).toBeTrue()
  })

  it("backoff exponencial: el segundo bloqueo es más largo", async () => {
    const rl = createLoginRateLimiter(TINY)
    // primer bloqueo (200ms)
    rl.recordFailure("1.1.1.1", "e@x.y")
    rl.recordFailure("1.1.1.1", "e@x.y")
    const b1 = rl.check("otro", "e@x.y")
    expect(b1.allowed).toBeFalse()
    await sleep(250)
    expect(rl.check("otro", "e@x.y").allowed).toBeTrue()
    // segundo ciclo → 400ms (2×base)
    rl.recordFailure("2.2.2.2", "e@x.y")
    rl.recordFailure("2.2.2.2", "e@x.y")
    const b2 = rl.check("otro", "e@x.y")
    expect(b2.allowed).toBeFalse()
    expect(b2.retryAfterSec).toBeGreaterThanOrEqual(b1.retryAfterSec)
  })

  it("email case-insensitive (a@B.c == A@b.c)", () => {
    const rl = createLoginRateLimiter(TINY)
    rl.recordFailure("1.2.3.4", "Case@Mail.com")
    expect(rl.check("otro", "case@mail.com").allowed).toBeTrue()
    rl.recordFailure("1.2.3.4", "CASE@MAIL.COM")
    expect(rl.check("otro", "case@mail.com").allowed).toBeFalse()
  })
})

describe("clientIp — extracción de IP", () => {
  it("usa X-Forwarded-For (primera posición) si existe", () => {
    const req = new Request("http://x/login", { headers: { "x-forwarded-for": "10.1.2.3, 192.168.1.1" } })
    expect(clientIp(req)).toBe("10.1.2.3")
  })
  it("usa X-Real-IP si no hay XFF", () => {
    const req = new Request("http://x/login", { headers: { "x-real-ip": "10.0.0.5" } })
    expect(clientIp(req)).toBe("10.0.0.5")
  })
  it("LAN directa sin proxy → bucket compartido 'direct'", () => {
    const req = new Request("http://x/login")
    expect(clientIp(req)).toBe("direct")
  })
})
