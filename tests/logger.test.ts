/**
 * Tests del logger estructurado (FASE 26).
 *
 * Cubre:
 *  · redact(): elimina/trunca campos peligrosos (password/secret/token/JWT…
 *    jamás llegan a un log; la clave de stream se trunca a 4 chars)
 *  · logEvent(): línea JSON válida con {ts, level, event, actor, ip, …}
 *  · rotación por tamaño (app.log → app.log.1 → …)
 *  · logError(): nivel error + success:false + mensaje del error
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// El logger resuelve LOG_DIR al PRIMER uso (cache) → aislar por proceso con
// env antes de importar. Bun importa estáticamente: usamos require dinámico
// tras fijar el entorno.
const tmp = mkdtempSync(join(tmpdir(), "logger-test-"))
process.env.LOG_DIR = tmp

const { redact, logEvent, logError } = await import("../src/lib/logger")

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  // re-crear el directorio (el logger lo cacheó ya; mkdir es recursive)
})

describe("redact() — sanitización", () => {
  it("elimina password/secret/token/authorization", () => {
    const out = redact({
      password: "secreto",
      passwordHash: "abc:def",
      AUTHORIZATION: "Bearer x",
      token: "jwt-completo",
      streamKey: "clave-larga-de-stream",
      normal: "ok",
    }) as Record<string, unknown>
    expect(out.password).toBe("[REDACTED]")
    expect(out.passwordHash).toBe("[REDACTED]")
    expect(out.AUTHORIZATION).toBe("[REDACTED]")
    expect(out.token).toBe("[REDACTED]")
    expect(out.normal).toBe("ok")
    expect(JSON.stringify(out)).not.toContain("secreto")
    expect(JSON.stringify(out)).not.toContain("jwt-completo")
  })

  it("la clave de stream se TRUNCA (identificable, nunca completa)", () => {
    const out = redact({ key: "abcd1234efgh" }) as Record<string, unknown>
    expect(out.key).toBe("abcd****")
    expect(JSON.stringify(out)).not.toContain("efgh")
  })

  it("anidado y arrays: aplica en profundidad", () => {
    const out = redact({ user: { password: "x", name: "Ana" }, list: [{ token: "t" }, { ok: 1 }] }) as Record<string, unknown>
    const user = out.user as Record<string, unknown>
    const list = out.list as Record<string, unknown>[]
    expect(user.password).toBe("[REDACTED]")
    expect(user.name).toBe("Ana")
    expect(list[0].token).toBe("[REDACTED]")
    expect(list[1].ok).toBe(1)
  })

  it("strings largos se truncan (evita volcar payloads enormes)", () => {
    const big = "x".repeat(1000)
    const out = redact({ data: big }) as Record<string, unknown>
    expect(String(out.data).length).toBeLessThanOrEqual(513)
    expect(String(out.data)).toContain("…")
  })
})

describe("logEvent() — línea JSON estructurada", () => {
  it("escribe JSON válido con ts/level/event/actor/ip en stdout y archivo", () => {
    const lines: string[] = []
    const origLog = console.log
    console.log = (l: string) => lines.push(l)
    try {
      logEvent({
        event: "LOGIN",
        actor: { uid: "u1", name: "Admin" },
        ip: "10.0.0.5",
        resource: "user",
        resourceId: "u1",
        success: true,
      })
    } finally {
      console.log = origLog
    }
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed.event).toBe("LOGIN")
    expect(parsed.level).toBe("info")
    expect(parsed.ts).toBeTruthy()
    expect((parsed.actor as Record<string, unknown>).uid).toBe("u1")
    expect(parsed.ip).toBe("10.0.0.5")
    expect(parsed.resource).toBe("user")
    expect(parsed.success).toBe(true)

    // también quedó en el archivo rotativo
    const file = join(tmp, "app.log")
    expect(existsSync(file)).toBeTrue()
    const fileLine = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!) as Record<string, unknown>
    expect(fileLine.event).toBe("LOGIN")
  })

  it("meta pasa por redact (password dentro de meta NUNCA aparece)", () => {
    const lines: string[] = []
    const origWarn = console.warn
    console.warn = (l: string) => lines.push(l)
    try {
      logEvent({ event: "X", level: "warn", meta: { password: "no-ver", note: "sí" } })
    } finally {
      console.warn = origWarn
    }
    expect(lines[0]).not.toContain("no-ver")
    expect(lines[0]).toContain("sí")
    expect(lines[0]).toContain("[REDACTED]")
  })
})

describe("logError() — errores con contexto", () => {
  it("nivel error + success:false + message del error", () => {
    const lines: string[] = []
    const origErr = console.error
    console.error = (l: string) => lines.push(l)
    try {
      logError("UPLOAD_FAILED", new Error("disco lleno"), { resource: "media" })
    } finally {
      console.error = origErr
    }
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed.level).toBe("error")
    expect(parsed.event).toBe("UPLOAD_FAILED")
    expect(parsed.success).toBe(false)
    expect((parsed.meta as Record<string, unknown>).error).toBe("disco lleno")
  })
})

describe("rotación por tamaño", () => {
  it("app.log supera el tamaño → rota a app.log.1", () => {
    const file = join(tmp, "app.log")
    rmSync(tmp, { recursive: true, force: true })
    // llenar el archivo activo por encima del umbral (5MB) sin pasar por el
    // logger: el próximo evento debe detectar el tamaño y rotar
    mkdirSync(tmp, { recursive: true })
    writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 100))
    logEvent({ event: "ROTATE_TEST" })
    expect(existsSync(`${file}.1`)).toBeTrue()
    // el contenido viejo pasó a .1 y el nuevo evento quedó en app.log
    expect(statSync(`${file}.1`).size).toBeGreaterThan(5 * 1024 * 1024)
    const active = readFileSync(file, "utf8").trim()
    expect(active).toContain("ROTATE_TEST")
  })
})

// limpieza final
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})
