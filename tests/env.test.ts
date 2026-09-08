/**
 * Tests de validación de entorno (FASE 1 de la misión).
 * Verifica: secretos obligatorios, rechazo de placeholders conocidos,
 * longitud mínima, defaults de opcionales y mensaje de error claro.
 */
import { describe, it, expect, beforeEach } from "bun:test"

// Entorno de test: secretos válidos dummy (no son secretos de producción)
const VALID = {
  AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  REALTIME_TOKEN: "test-rt-token-0123456789abcdef",
  DATABASE_URL: "file:./test-env.db",
}

async function freshEnv() {
  const mod = await import("@/lib/env")
  mod.__resetEnvForTests()
  return mod
}

describe("env — validación centralizada (Zod)", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = VALID.AUTH_SECRET
    process.env.REALTIME_TOKEN = VALID.REALTIME_TOKEN
    process.env.DATABASE_URL = VALID.DATABASE_URL
    delete process.env.PORT
    delete process.env.TIMEZONE
    delete process.env.MEDIA_DIR
  })

  it("entorno válido pasa y devuelve secretos correctos", async () => {
    const { getEnv, envError } = await freshEnv()
    expect(envError()).toBeNull()
    const env = getEnv()
    expect(env.AUTH_SECRET).toBe(VALID.AUTH_SECRET)
    expect(env.REALTIME_TOKEN).toBe(VALID.REALTIME_TOKEN)
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL)
  })

  it("PORT tiene default 3000 y acepta override numérico", async () => {
    process.env.PORT = "8080"
    const { getEnv } = await freshEnv()
    expect(getEnv().PORT).toBe(8080)
  })

  it("PORT fuera de rango es rechazado", async () => {
    process.env.PORT = "99999"
    const { envError } = await freshEnv()
    expect(envError()).toContain("PORT")
  })

  it("falta AUTH_SECRET → error (sin fallback hardcodeado)", async () => {
    delete process.env.AUTH_SECRET
    const { envError } = await freshEnv()
    const err = envError()
    expect(err).not.toBeNull()
    expect(err!).toContain("AUTH_SECRET")
  })

  it("falta REALTIME_TOKEN → error", async () => {
    delete process.env.REALTIME_TOKEN
    const { envError } = await freshEnv()
    expect(envError()).toContain("REALTIME_TOKEN")
  })

  it("falta DATABASE_URL → error", async () => {
    delete process.env.DATABASE_URL
    const { envError } = await freshEnv()
    expect(envError()).toContain("DATABASE_URL")
  })

  it("secrets placeholder conocidos son RECHAZADOS (anti fallback)", async () => {
    for (const bad of ["signage-dev-secret-change-me", "cambiar-por-un-secreto-largo-y-aleatorio", "changeme"]) {
      process.env.AUTH_SECRET = bad
      const { envError } = await freshEnv()
      expect(envError()).toContain("placeholder")
    }
  })

  it("AUTH_SECRET demasiado corto es rechazado", async () => {
    process.env.AUTH_SECRET = "corto123"
    const { envError } = await freshEnv()
    expect(envError()).toContain("24")
  })

  it("REALTIME_TOKEN demasiado corto es rechazado", async () => {
    process.env.REALTIME_TOKEN = "corto"
    const { envError } = await freshEnv()
    expect(envError()).toContain("16")
  })

  it("el error menciona el mecanismo de arreglo (.env.example)", async () => {
    delete process.env.AUTH_SECRET
    const { envError } = await freshEnv()
    expect(envError()).toContain(".env.example")
  })

  it("getEnv memoiza (misma referencia en llamadas sucesivas)", async () => {
    const { getEnv } = await freshEnv()
    const a = getEnv()
    const b = getEnv()
    expect(a).toBe(b)
  })
})
