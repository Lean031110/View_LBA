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
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
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
  })

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
  })

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
  })

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
  })
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
  })

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
  })

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
  })

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
  })

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
  })
})

describe("realtime-service: broadcast interno", () => {
  it("token incorrecto → 401", async () => {
    const res = await fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": "incorrecto" },
      body: JSON.stringify({ event: "x", payload: {} }),
    })
    expect(res.status).toBe(401)
  })

  it("broadcast a pantallas SANEADO (sin publisherIp) y con audioInfo en snapshot", async () => {
    // conectar una pantalla y reportar audio (F7)
    const gotStream = await new Promise<Record<string, unknown> | null>((res) => {
      const s = connect()
      s.on("connect", () => {
        s.emit("screen:register", { screenCode: "TV-002", resolution: "800x600", userAgent: "t" })
        s.on("screen:registered", async () => {
          s.emit("screen:audio", { devices: [{ deviceId: "d1", label: "HDMI" }], supportsSinkId: true })
          // esperar (determinista) a que el servicio procese screen:audio
          // antes de leer el snapshot (socket y HTTP son transportes distintos)
          try {
            await waitFor(
              async () => {
                const st = await fetch(`http://127.0.0.1:${INTERNAL}/status`, { cache: "no-store" }).then((r) => r.json() as Promise<{ screens: { screenCode: string; audioInfo: { devices: unknown[] } | null }[] }>)
                return st.screens.some((sc) => sc.screenCode === "TV-002" && (sc.audioInfo?.devices?.length ?? 0) >= 1)
              },
              (ok) => ok === true,
              5000
            )
          } catch {
            // el broadcast/saneo se valida igual; el audioInfo se reintenta abajo
          }
          // broadcast con dato sensible
          fetch(`http://127.0.0.1:${INTERNAL}/broadcast`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-internal-token": REALTIME_TOKEN },
            body: JSON.stringify({ event: "stream:server", payload: { live: true, publisherIp: "1.2.3.4" }, target: "screens" }),
          }).catch(() => {})
        })
        s.on("stream:server", (payload: Record<string, unknown>) => {
          s.disconnect()
          res(payload)
        })
      })
      setTimeout(() => { s.disconnect(); res(null) }, 6000)
    })
    expect(gotStream).not.toBeNull()
    expect(gotStream!).not.toHaveProperty("publisherIp")
    expect((gotStream as { live?: boolean }).live).toBe(true)

    // snapshot con audioInfo (espera determinista; cualquier entrada TV-002
    // con audioInfo — el socket del test anterior puede seguir 1-2s presente)
    const tv2 = await waitFor(
      async () => {
        const st = await fetch(`http://127.0.0.1:${INTERNAL}/status`, { cache: "no-store" }).then((r) => r.json() as Promise<{ screens: { screenCode: string; socketCode?: string; audioInfo: { devices: unknown[] } | null }[]; ok?: boolean }>)
        return st.screens.find((sc) => sc.screenCode === "TV-002" && (sc.audioInfo?.devices?.length ?? 0) >= 1) ?? null
      },
      (sc) => Boolean(sc),
      5000
    )
    expect(tv2?.audioInfo?.devices?.length).toBe(1)
  })
})

describe("realtime-service: health", () => {
  it("GET /health responde ok con uptime", async () => {
    const res = await fetch(`http://127.0.0.1:${INTERNAL}/health`)
    expect(res.status).toBe(200)
    const d = (await res.json()) as { ok: boolean; uptimeSec: number }
    expect(d.ok).toBeTrue()
    expect(d.uptimeSec).toBeGreaterThanOrEqual(0)
  })
})
