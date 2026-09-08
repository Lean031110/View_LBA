/**
 * Prueba EN VIVO de la autenticación del realtime-service (FASE 5).
 * Conecta sockets reales contra :3003 y verifica:
 *   1. admin:register SIN cookie → rechazado
 *   2. admin:register CON cookie válida (mintada con el AUTH_SECRET real) → aceptado
 *   3. admin:command sin auth → rechazado
 *   4. screen:register código desconocido → rechazado
 *   5. screen:register código válido → aceptado (no verificada)
 *   6. stream:server hacia pantallas SANEADO (sin publisherIp)
 *
 * Uso: bun scripts/verify-realtime-auth.ts
 */
import { io } from "socket.io-client"
import { createHmac, createHash } from "crypto"
import { readFileSync } from "fs"

function parseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}
const ENV = parseEnv()
const SECRET = ENV.AUTH_SECRET

function mintSession(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url")
  return `${body}.${sig}`
}

const URL = "http://127.0.0.1:3003"
const OPTS = { path: "/", transports: ["websocket" as const], reconnection: false, timeout: 8000 }

function connect(extraHeaders: Record<string, string> = {}) {
  return io(URL, { ...OPTS, extraHeaders })
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  let failures = 0
  const check = (name: string, ok: boolean) => {
    console.log(`${ok ? "✓" : "✗ FALLO"} ${name}`)
    if (!ok) failures++
  }

  // ---- 1. Admin SIN cookie ----
  await new Promise<void>((resolve) => {
    const s = connect()
    s.on("connect", () => {
      s.emit("admin:register")
      s.on("admin:rejected", () => {
        check("1. admin:register SIN cookie → rechazado", true)
        s.disconnect()
        resolve()
      })
      s.on("screens:snapshot", () => {
        check("1. admin:register SIN cookie → rechazado", false)
        s.disconnect()
        resolve()
      })
    })
    s.on("connect_error", () => {
      check("1. admin:register SIN cookie → rechazado", false)
      resolve()
    })
  })

  // ---- 2. Admin CON cookie válida (usuario admin real, authVersion 0, exp futuro) ----
  // Necesitamos el uid real del admin de la DB
  const { Database } = await import("bun:sqlite")
  const db = new Database("db/custom.db", { readonly: true })
  const admin = db.query("SELECT id, role, active, authVersion, email, name FROM User WHERE email='admin@restaurante.com'").get() as
    | { id: string; role: string; active: number; authVersion: number; email: string; name: string }
    | undefined
  if (!admin) throw new Error("usuario admin no encontrado en DB")
  const token = mintSession({
    uid: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    av: admin.authVersion,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  db.close()

  let adminOk = false
  await new Promise<void>((resolve) => {
    const s = connect({ cookie: `signage_session=${token}` })
    s.on("connect", () => {
      s.emit("admin:register")
      s.on("screens:snapshot", () => {
        adminOk = true
        check("2. admin:register CON cookie válida → aceptado (snapshot recibido)", true)
        // ---- 3. admin:command con sesión válida → permitido (probar envío) ----
        s.emit("admin:command", { type: "reload" })
        setTimeout(() => {
          s.disconnect()
          resolve()
        }, 500)
      })
      s.on("admin:rejected", () => {
        check("2. admin:register CON cookie válida → aceptado", false)
        s.disconnect()
        resolve()
      })
    })
  })

  // ---- 3b. admin:command desde socket SIN auth (cookie inválida) ----
  await new Promise<void>((resolve) => {
    const s = connect({ cookie: "signage_session=falso.token" })
    let done = false
    const fallback = setTimeout(() => {
      if (!done) {
        done = true
        check("3. admin:command con cookie inválida → rechazado", false)
        s.disconnect()
        resolve()
      }
    }, 2000)
    s.on("connect", () => {
      s.emit("admin:command", { type: "reload" })
      s.on("admin:rejected", () => {
        if (done) return
        done = true
        clearTimeout(fallback)
        check("3. admin:command con cookie inválida → rechazado", true)
        s.disconnect()
        resolve()
      })
    })
  })

  // ---- 4. Pantalla con código desconocido ----
  await new Promise<void>((resolve) => {
    const s = connect()
    s.on("connect", () => {
      s.emit("screen:register", { screenCode: "TV-HACK", resolution: "1x1", userAgent: "test" })
      s.on("screen:rejected", (d: { reason: string }) => {
        check(`4. screen:register código desconocido → rechazado (${d.reason})`, true)
        s.disconnect()
        resolve()
      })
      s.on("screen:registered", () => {
        check("4. screen:register código desconocido → rechazado", false)
        s.disconnect()
        resolve()
      })
    })
  })

  // ---- 5. Pantalla válida (TV-001 sin pairing) ----
  await new Promise<void>((resolve) => {
    const s = connect()
    let gotSanitized: unknown = null
    s.on("connect", () => {
      s.emit("screen:register", { screenCode: "TV-001", resolution: "1920x1080", userAgent: "test" })
      s.on("screen:registered", (d: { verified: boolean }) => {
        check(`5. screen:register TV-001 → aceptada (verified=${d.verified})`, true)
        // ---- 6. broadcast stream:server con publisherIp → la pantalla NO debe verlo ----
        // (usar la API interna con el token real)
        fetch("http://127.0.0.1:3004/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": ENV.REALTIME_TOKEN },
          body: JSON.stringify({
            event: "stream:server",
            payload: { source: "local", live: true, publisherIp: "1.2.3.4", ts: 1 },
            target: "screens",
          }),
        }).catch(() => {})
      })
      s.on("stream:server", (payload: Record<string, unknown>) => {
        gotSanitized = payload
      })
      setTimeout(() => {
        const p = gotSanitized as Record<string, unknown> | null
        check(
          `6. stream:server hacia pantalla SANEADO (publisherIp ${p ? ("publisherIp" in p ? "PRESENTE ✗" : "eliminado ✓") : "no recibido ✗"})`,
          Boolean(p && !("publisherIp" in p))
        )
        s.disconnect()
        resolve()
      }, 2500)
    })
  })

  console.log(failures === 0 ? "\nTODAS LAS PRUEBAS PASARON" : `\n${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("Error:", e)
  process.exit(1)
})
