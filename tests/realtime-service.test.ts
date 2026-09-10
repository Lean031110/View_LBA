/**
 * Tests del SERVICIO REALTIME (FASE 22) — spawn real del mini-servicio.
 *
 * Levanta mini-services/realtime-service en puertos de test (3103/3104) con
 * una DB temporal y valida por socket.io real:
 *   · admin:register sin cookie → rechazado / con cookie válida → aceptado
 *   · admin:command sin auth → ignorado+rechazado
 *   · screen:register desconocida/inactiva/token malo → rechazada
 *   · screen:register válida → aceptada (verified con token)
 *   · broadcast con token incorrecto → 401; correcto → entrega
 *   · heartbeat actualiza lastSeen; snapshot incluye audioInfo (F7)
 *   · stream:server a pantallas SIN publisherIp (saneado)
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync, cpSync, mkdirSync } from "fs"
import { createHash, createHmac, randomBytes } from "crypto"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { io, type Socket } from "socket.io-client"

const ROOT = resolve(import.meta.dir, "..")
const SERVICE = join(ROOT, "mini-services", "realtime-service")
const PORT = 3103
const INTERNAL = 3104
const URL = `http://127.0.0.1:${PORT}`

const AUTH_SECRET = "rt-test-secret-0123456789abcdef0123456789"
const REALTIME_TOKEN = "rt-test-internal-token-0123456789abcdef"

let proc: ChildProcess | null = null
let tmpDir = ""
let dbPath = ""
let adminId = ""

/** Crea la DB temporal con un usuario admin y una pantalla con token */
function setupDb() {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE User (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, passwordHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'OPERATOR', active BOOLEAN NOT NULL DEFAULT 1, authVersion INTEGER NOT NULL DEFAULT 0, lastLoginAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL);
    CREATE TABLE Screen (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, location TEXT, notes TEXT, active BOOLEAN NOT NULL DEFAULT 1, tokenHash TEXT, lastSeenAt DATETIME, metadata TEXT, audioDeviceId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL);
    CREATE TABLE Settings (id TEXT PRIMARY KEY);
  `)
  adminId = "test-admin-id"
  db.run("INSERT INTO User (id, email, name, passwordHash, role, updatedAt) VALUES (?, ?, ?, ?, 'ADMIN', CURRENT_TIMESTAMP)", [adminId, "a@b.c", "Admin", "x:y"])
  // TV-001 con token; TV-002 sin token (pendiente de pairing); TV-003 inactiva
  const token = "pantalla-token-de-test-32-caracteres"
  const hash = createHash("sha256").update(token).digest("hex")
  db.run("INSERT INTO Screen (id, code, name, active, tokenHash, updatedAt) VALUES ('s1', 'TV-001', 'Uno', 1, ?, CURRENT_TIMESTAMP)", [hash])
  db.run("INSERT INTO Screen (id, code, name, active, tokenHash, updatedAt) VALUES ('s2', 'TV-002', 'Dos', 1, NULL, CURRENT_TIMESTAMP)")
  db.run("INSERT INTO Screen (id, code, name, active, tokenHash, updatedAt) VALUES ('s3', 'TV-003', 'Tres', 0, NULL, CURRENT_TIMESTAMP)")
  db.close()
  return token
}

let screenToken = ""

function mintSession(av = 0): string {
  const body = Buffer.from(
    JSON.stringify({ uid: adminId, email: "a@b.c", name: "Admin", role: "ADMIN", av, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url")
  const sig = createHmac("sha256", AUTH_SECRET).update(body).digest("base64url")
  return `${body}.${sig}`
}

function connect(extraHeaders: Record<string, string> = {}): Socket {
  return io(URL, { path: "/", transports: ["websocket"], reconnection: false, timeout: 6000, extraHeaders })
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (v: T) => boolean, ms = 6000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (predicate(v)) return v
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout")
    await wait(200)
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "rt-test-"))
  dbPath = join(tmpDir, "test.db")
  screenToken = setupDb()

  // Workaround de sandbox: posix_spawn del binario bun falla intermitente
  // desde bun test → lanzar vía /bin/sh -c (siempre disponible).
  const envFlags = `DATABASE_URL='file:${dbPath}' AUTH_SECRET='${AUTH_SECRET}' REALTIME_TOKEN='${REALTIME_TOKEN}' REALTIME_PORT='${PORT}' REALTIME_INTERNAL_PORT='${INTERNAL}'`
  proc = spawn("/bin/sh", ["-c", `cd '${SERVICE}' && ${envFlags} exec '${process.execPath}' index.ts`], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  proc.stdout!.on("data", (d) => console.log("[svc]", d.toString().trim()))
  proc.stderr!.on("data", (d) => console.log("[svc-err]", d.toString().trim()))
  proc.on("exit", (c) => console.log("[svc-exit]", String(c)))
  // esperar a que el health responda
  await waitFor(
    () => fetch(`http://127.0.0.1:${INTERNAL}/health`).then((r) => r.status).catch(() => 0),
    (s) => s === 200,
    15000
  )
})

afterAll(() => {
  proc?.kill("SIGKILL")
  proc = null
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe("realtime-service: autenticación admin", () => {
  it("admin:register SIN cookie → rechazado", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("admin:register")
        s.on("admin:rejected", () => { s.disconnect(); res("rejected") })
        s.on("screens:snapshot", () => { s.disconnect(); res("snapshot") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("rejected")
  }, 15000)

  it("admin:register CON cookie válida → aceptado con snapshot", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect({ cookie: `signage_session=${mintSession(0)}` })
      s.on("connect", () => {
        s.emit("admin:register")
        s.on("screens:snapshot", (d: { screens: unknown[] }) => {
          const ok = Array.isArray(d.screens)
          s.disconnect()
          res(ok ? "snapshot" : "mal")
        })
        s.on("admin:rejected", () => { s.disconnect(); res("rejected") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("snapshot")
  }, 15000)

  it("admin:register con authVersion VIEJA → rechazado (sesión invalidada)", async () => {
    const result = await new Promise<string>((res) => {
      // token con av=5 pero la DB dice av=0
      const s = connect({ cookie: `signage_session=${mintSession(5)}` })
      s.on("connect", () => {
        s.emit("admin:register")
        s.on("admin:rejected", () => { s.disconnect(); res("rejected") })
        s.on("screens:snapshot", () => { s.disconnect(); res("snapshot") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("rejected")
  }, 15000)

  it("admin:command sin autenticación → ignorado con rechazo", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("admin:command", { type: "reload" })
        s.on("admin:rejected", () => { s.disconnect(); res("rejected") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("rejected")
  }, 15000)
})

describe("realtime-service: autenticación de pantallas (pairing)", () => {
  it("código desconocido → rechazada", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-999", resolution: "1x1", userAgent: "t" })
        s.on("screen:rejected", (d: { reason: string }) => { s.disconnect(); res(d.reason) })
        s.on("screen:registered", () => { s.disconnect(); res("registered") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("unknown")
  }, 15000)

  it("pantalla INACTIVA → rechazada", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-003", resolution: "1x1", userAgent: "t" })
        s.on("screen:rejected", (d: { reason: string }) => { s.disconnect(); res(d.reason) })
        s.on("screen:registered", () => { s.disconnect(); res("registered") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("inactive")
  }, 15000)

  it("TV-001 con token CORRECTO → aceptada y verificada", async () => {
    const result = await new Promise<unknown>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-001", resolution: "1920x1080", userAgent: "t", token: screenToken })
        s.on("screen:registered", (d: unknown) => { s.disconnect(); res(d) })
        s.on("screen:rejected", (d: unknown) => { s.disconnect(); res(d) })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    const d = result as { ok?: boolean; verified?: boolean; screenCode?: string }
    expect(d.ok).toBeTrue()
    expect(d.verified).toBeTrue()
    expect(d.screenCode).toBe("TV-001")
  }, 15000)

  it("TV-001 con token INCORRECTO → rechazada (anti-suplantación)", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-001", resolution: "1x1", userAgent: "t", token: "token-falso" })
        s.on("screen:rejected", (d: { reason: string }) => { s.disconnect(); res(d.reason) })
        s.on("screen:registered", () => { s.disconnect(); res("registered") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("bad-token")
  }, 15000)

  it("TV-002 sin token (sin emparejar) → aceptada NO verificada", async () => {
    const result = await new Promise<unknown>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-002", resolution: "800x600", userAgent: "t" })
        s.on("screen:registered", (d: unknown) => { s.disconnect(); res(d) })
        s.on("screen:rejected", (d: unknown) => { s.disconnect(); res(d) })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    const d = result as { ok?: boolean; verified?: boolean }
    expect(d.ok).toBeTrue()
    expect(d.verified).toBeFalse()
  }, 15000)
})

describe("realtime-service: broadcast interno", () => {
  it("token incorrecto → 401", async () => {
    const res = await fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": "incorrecto" },
      body: JSON.stringify({ event: "x", payload: {} }),
    })
    expect(res.status).toBe(401)
  }, 15000)

  it("broadcast a pantallas SANEADO (sin publisherIp) y con audioInfo en snapshot", async () => {
    // conectar una pantalla y reportar audio (F7).
    // El socket se mantiene VIVO hasta el final: /status solo lista pantallas
    // CONECTADAS (el servicio las elimina al desconectar) — verificar audioInfo
    // después de desconectar sería una carrera no determinista (bug del test).
    let sock: Socket | null = null
    const audioInfoSeen = { value: false }
    const gotStream = await new Promise<Record<string, unknown> | null>((res) => {
      const s = connect()
      sock = s
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-002", resolution: "800x600", userAgent: "t" })
        s.on("screen:registered", async () => {
          s.emit("screen:audio", { devices: [{ deviceId: "d1", label: "HDMI" }], supportsSinkId: true })
          // esperar (determinista: el socket sigue conectado) a que el servicio
          // procese screen:audio y lo refleje en /status (socket y HTTP son
          // transportes distintos)
          try {
            await waitFor(
              async () => {
                const st = await fetch(`http://127.0.0.1:${INTERNAL}/status`, { cache: "no-store" }).then((r) => r.json() as Promise<{ screens: { screenCode: string; audioInfo: { devices: unknown[] } | null }[] }>)
                return st.screens.some((sc) => sc.screenCode === "TV-002" && (sc.audioInfo?.devices?.length ?? 0) >= 1)
              },
              (ok) => ok === true,
              5000
            )
            audioInfoSeen.value = true
          } catch {
            // se reporta abajo con expect(audioInfoSeen) — no aborta el flujo
          }
          // broadcast con dato sensible
          fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-internal-token": REALTIME_TOKEN },
            body: JSON.stringify({ event: "stream:server", payload: { live: true, publisherIp: "1.2.3.4" }, target: "screens" }),
          }).catch(() => {})
        })
        s.on("stream:server", (payload: Record<string, unknown>) => {
          res(payload) // NO desconectar: las aserciones siguen con el socket vivo
        })
      })
      setTimeout(() => { s.disconnect(); res(null) }, 8000)
    })
    try {
      expect(gotStream).not.toBeNull()
      expect(gotStream!).not.toHaveProperty("publisherIp")
      expect((gotStream as { live?: boolean }).live).toBe(true)

      // FASE 7: audioInfo reportado por la pantalla visible en /status (snapshot)
      // mientras la pantalla está conectada
      expect(audioInfoSeen.value).toBeTrue()
    } finally {
      sock?.disconnect()
    }
  }, 25000)
})

describe("realtime-service: FASE 32 — pairing por código temporal", () => {
  it("pair:wait con código inválido → pair:error", async () => {
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("pair:wait", { pairCode: "ABC123" })
        s.on("pair:error", (d: { error?: string }) => { s.disconnect(); res(d.error ?? "") })
        setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 6000)
    })
    expect(result).toContain("inválido")
  }, 15000)

  it("room sin TV esperando → broadcast responde clients:0 y NO entrega", async () => {
    const res = await fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": REALTIME_TOKEN },
      body: JSON.stringify({ event: "pair:complete", room: "pair:999999", payload: { screenCode: "TV-002", token: "nadie-recibe-esto" } }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok?: boolean; clients?: number }
    expect(data.ok).toBeTrue()
    expect(data.clients).toBe(0)
  }, 15000)

  it("flujo COMPLETO: pair:wait → pair:complete al room → TV recibe token → register VERIFICADO", async () => {
    const pairCode = "424242"
    const newToken = "nuevo-token-entregado-por-pairing-32c"

    // 1. TV sin identidad conecta y espera su código de vinculación
    const s = connect()
    try {
      const tokenPromise = new Promise<{ screenCode: string; token: string }>((res) => {
        s.on("pair:complete", (d: { screenCode?: string; token?: string }) => {
          res({ screenCode: String(d.screenCode ?? ""), token: String(d.token ?? "") })
        })
        setTimeout(() => res({ screenCode: "", token: "" }), 8000)
      })
      const joined = await new Promise<boolean>((res) => {
        s.on("connect", () => {
          s.emit("pair:wait", { pairCode })
          setTimeout(() => res(true), 500)
        })
        setTimeout(() => res(false), 5000)
      })
      expect(joined).toBeTrue()

      // 2. El "API" (como la ruta real): actualiza el hash ANTES de difundir
      const hash = createHash("sha256").update(newToken).digest("hex")
      const db = new Database(dbPath)
      db.run("UPDATE Screen SET tokenHash = ? WHERE code = 'TV-002'", [hash])
      db.close()

      // 3. Broadcast interno al room → la TV en espera lo recibe
      const res = await fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": REALTIME_TOKEN },
        body: JSON.stringify({
          event: "pair:complete",
          room: `pair:${pairCode}`,
          payload: { screenCode: "TV-002", token: newToken, name: "Dos" },
        }),
      })
      const data = (await res.json()) as { ok?: boolean; clients?: number }
      expect(data.ok).toBeTrue()
      expect(data.clients).toBe(1) // la TV estaba esperando

      // 4. La TV "persiste" el token (aquí: lo usa directamente) y se registra
      const got = await tokenPromise
      expect(got.screenCode).toBe("TV-002")
      expect(got.token).toBe(newToken)

      const reg = await new Promise<unknown>((res2) => {
        s.on("screen:registered", (d: unknown) => res2(d))
        s.on("screen:rejected", (d: unknown) => res2(d))
        s.emit("screen:register", { screenCode: "TV-002", resolution: "1920x1080", userAgent: "t", token: newToken })
        setTimeout(() => res2("timeout"), 5000)
      })
      const d = reg as { ok?: boolean; verified?: boolean; screenCode?: string }
      expect(d.ok).toBeTrue()
      expect(d.verified).toBeTrue() // emparejada de verdad: sha256 coincide
      expect(d.screenCode).toBe("TV-002")
    } finally {
      s.disconnect()
    }
  }, 20000)

  it("REGENERACIÓN del token → el token ANTIGUO queda rechazado", async () => {
    // (muta TV-001 al final del archivo a propósito: los tests anteriores ya
    // validaron el token original; este simula POST /token o re-vinculación)
    // 1. acepta con el token vigente (sanity)
    const okBefore = await new Promise<unknown>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-001", resolution: "1x1", userAgent: "t", token: screenToken })
        s.on("screen:registered", (d: unknown) => { s.disconnect(); res(d) })
        s.on("screen:rejected", (d: unknown) => { s.disconnect(); res(d) })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect((okBefore as { verified?: boolean }).verified).toBeTrue()

    // 2. regenerar: hash NUEVO en la DB (lo que hace la ruta /token)
    const db = new Database(dbPath)
    db.run("UPDATE Screen SET tokenHash = ? WHERE code = 'TV-001'", [
      createHash("sha256").update("token-regenerado-33333333").digest("hex"),
    ])
    db.close()

    // 3. el token ANTIGUO (el que la TV aún tiene en localStorage) → rechazado
    const result = await new Promise<string>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-001", resolution: "1x1", userAgent: "t", token: screenToken })
        s.on("screen:rejected", (d: { reason: string }) => { s.disconnect(); res(d.reason) })
        s.on("screen:registered", () => { s.disconnect(); res("registered") })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect(result).toBe("bad-token")

    // 4. y el token NUEVO funciona (la re-vinculación sirve)
    const okAfter = await new Promise<unknown>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-001", resolution: "1x1", userAgent: "t", token: "token-regenerado-33333333" })
        s.on("screen:registered", (d: unknown) => { s.disconnect(); res(d) })
        s.on("screen:rejected", (d: unknown) => { s.disconnect(); res(d) })
      })
      setTimeout(() => { s.disconnect(); res("timeout") }, 5000)
    })
    expect((okAfter as { verified?: boolean }).verified).toBeTrue()
  }, 25000)
})

describe("realtime-service: reporte de estado de stream (stream:status)", () => {
  it("stream:report de una pantalla → el admin recibe streamState (no «state»)", async () => {
    // Regresión: el payload usaba «state» pero AdminApp (ScreenStatus) espera
    // «streamState» → el pill de la pantalla quedaba congelado en CONECTANDO.
    // Aislamiento: los tests de FASE 32 (anteriores) dejan TV-002 con tokenHash
    // → se resetea a NULL para poder registrarla sin token (mismo patrón DB
    // directo que usan esos tests).
    const db = new Database(dbPath)
    db.run("UPDATE Screen SET tokenHash = NULL WHERE code = 'TV-002'")
    db.close()
    let screen: Socket | null = null
    let adminSock: Socket | null = null
    const got = await new Promise<Record<string, unknown> | null>((res) => {
      const a = connect({ cookie: `signage_session=${mintSession(0)}` })
      adminSock = a
      a.on("connect", () => {
        a.emit("admin:register")
        a.on("screens:snapshot", () => {
          // pantalla conectada tras el admin para recibir el flujo completo
          const s = connect()
          screen = s
          s.on("connect", () => {
            s.emit("screen:register", { screenCode: "TV-002", resolution: "800x600", userAgent: "t" })
            s.on("screen:registered", () => {
              s.emit("stream:report", {
                state: "live",
                resolution: "1920×1080",
                bitrate: 4500000,
                uptime: 42,
                reconnects: 0,
              })
            })
          })
        })
        a.on("stream:status", (d: Record<string, unknown>) => {
          if (d.screenCode === "TV-002") {
            a.disconnect()
            res(d)
          }
        })
      })
      setTimeout(() => { a.disconnect(); res(null) }, 8000)
    })
    try {
      expect(got).not.toBeNull()
      expect(got!.screenCode).toBe("TV-002")
      expect(got!.streamState).toBe("live") // ← la clave que consume el panel
      expect(got!).not.toHaveProperty("state") // ← la clave antigua (bug)
      expect(got!.resolution).toBe("1920×1080")
    } finally {
      screen?.disconnect()
      adminSock?.disconnect()
    }
  }, 15000)
})

describe("realtime-service: health", () => {
  it("GET /health responde ok con uptime", async () => {
    const res = await fetch(`http://127.0.0.1:${INTERNAL}/health`)
    expect(res.status).toBe(200)
    const d = (await res.json()) as { ok: boolean; uptimeSec: number }
    expect(d.ok).toBeTrue()
    expect(d.uptimeSec).toBeGreaterThanOrEqual(0)
  }, 15000)
})
