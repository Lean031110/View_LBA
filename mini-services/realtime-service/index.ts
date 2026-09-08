/**
 * Realtime Service — ViewLBA
 * ---------------------------
 * Hub Socket.io (puerto 3003) que conecta:
 *   - Pantallas TV (room "screens")  → heartbeat, métricas, estado del stream
 *   - Paneles Admin  (room "admins") → snapshots de pantallas, estado del stream
 *
 * El Next.js API llama a POST /broadcast (con token interno) para notificar
 * cambios de contenido a las pantallas en tiempo real.
 *
 * FASE 5 (misión) — seguridad del servicio:
 *   · CORS sin "*": solo orígenes propios/LAN/configurados (anti-CSWSH).
 *   · admin:register / admin:command EXIGEN cookie de sesión válida
 *     (HMAC + expiración + usuario activo + authVersion contra SQLite).
 *   · screen:register valida contra la tabla Screen: código conocido +
 *     pantalla activa + token de pairing si está configurado (sha256).
 *   · Los eventos hacia pantallas se sanean (sin publisherIp).
 *   · GET /health (3004) para el backend y el supervisor.
 */
import { createServer, IncomingMessage, ServerResponse } from "http"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Server, Socket } from "socket.io"
import { Database } from "bun:sqlite"
import {
  parseCookie,
  verifySessionToken,
  checkAdminSession,
  checkScreenAuth,
  originAllowed,
  sanitizeForScreens,
  sha256Hex,
  type AdminIdentity,
  type DbUserRow,
  type ScreenAuthRow,
} from "./auth"

// ---------- Entorno: .env del raíz del proyecto (independiente del CWD) ----------
function parseEnvFile(path: string): Record<string, string> {
  try {
    const txt = readFileSync(path, "utf8")
    const out: Record<string, string> = {}
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}
const ROOT_DIR = resolve(import.meta.dir, "..", "..")
const ENV = { ...parseEnvFile(resolve(ROOT_DIR, ".env")), ...process.env }

/** FASE 1 (misión): sin fallback de token — el servicio NO arranca sin credencial válida */
function requireRealtimeToken(): string {
  const t = (ENV.REALTIME_TOKEN || "").trim()
  const forbidden = new Set([
    "signage-rt-internal-token",
    "cambiar-por-otro-secreto-aleatorio",
    "changeme",
    "change-me",
  ])
  if (!t || t.length < 16 || forbidden.has(t.toLowerCase())) {
    console.error(
      "✗ REALTIME_TOKEN inválido o ausente. Genera uno real (openssl rand -hex 16) y ponlo en .env del raíz del proyecto."
    )
    process.exit(1)
  }
  return t
}

function requireAuthSecret(): string {
  const t = (ENV.AUTH_SECRET || "").trim()
  const forbidden = new Set([
    "signage-dev-secret-change-me",
    "cambiar-por-un-secreto-largo-y-aleatorio",
    "changeme",
    "change-me",
  ])
  if (!t || t.length < 24 || forbidden.has(t.toLowerCase())) {
    console.error(
      "✗ AUTH_SECRET inválido o ausente (necesario para validar sesiones admin en el handshake). Genera uno real (openssl rand -hex 24)."
    )
    process.exit(1)
  }
  return t
}

const INTERNAL_TOKEN = requireRealtimeToken()
const AUTH_SECRET = requireAuthSecret()
const SESSION_COOKIE = "signage_session"
const ALLOWED_ORIGINS = (ENV.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const PORT = Number(ENV.REALTIME_PORT || 3003) // Socket.io (navegadores, vía Caddy o LAN)
const INTERNAL_PORT = Number(ENV.REALTIME_INTERNAL_PORT || 3004) // API interna (solo localhost)
const OFFLINE_AFTER_MS = 45_000 // sin heartbeat → pantalla offline
const DB_PATH = (() => {
  const raw = (ENV.DATABASE_URL || `file:${resolve(ROOT_DIR, "db", "custom.db")}`).replace(/^file:/, "")
  return raw.startsWith("/") ? raw : resolve(ROOT_DIR, "prisma", raw)
})()

// ---------- DB SQLite (readonly: solo validaciones de auth) ----------
let dbHandle: Database | null = null
function queryRow<T>(sql: string, ...params: (string | number)[]): T | null {
  try {
    dbHandle ??= new Database(DB_PATH, { readonly: true })
    return (dbHandle.query(sql).get(...params) as T) ?? null
  } catch {
    // DB bloqueada/ausente → reabrir en el siguiente intento
    try {
      dbHandle?.close()
    } catch {}
    dbHandle = null
    return null
  }
}
function findUser(uid: string): DbUserRow | null {
  return queryRow<DbUserRow>("SELECT id, role, active, authVersion FROM User WHERE id = ?", uid)
}
function findScreen(code: string): ScreenAuthRow | null {
  return queryRow<ScreenAuthRow>("SELECT code, active, tokenHash FROM Screen WHERE code = ?", code)
}

// (lastSeenAt persistido con conexión efímera de escritura, throttled)
const LASTSEEN_WRITE_INTERVAL = 120_000 // por pantalla
const lastSeenWritten = new Map<string, number>()
function persistLastSeen(code: string): void {
  const now = Date.now()
  const last = lastSeenWritten.get(code) ?? 0
  if (now - last < LASTSEEN_WRITE_INTERVAL) return
  lastSeenWritten.set(code, now)
  try {
    const w = new Database(DB_PATH, { timeout: 4000 })
    try {
      w.query("UPDATE Screen SET lastSeenAt = ? WHERE code = ?").run(new Date().toISOString(), code)
    } finally {
      w.close()
    }
  } catch {
    // no crítico: el snapshot en memoria siempre manda
  }
}

// ---------- Estado en memoria ----------
interface ScreenEntry {
  socketId: string
  screenCode: string
  verified: boolean // ¿presentó token de pairing válido?
  resolution: string
  userAgent: string
  connectedAt: number
  lastSeen: number
  streamState: "live" | "connecting" | "offline" | "fallback" | "disabled"
  streamInfo: {
    resolution?: string
    bitrate?: number
    latency?: number
    uptime?: number
    reconnects?: number
  }
  // FASE 7: audio reportado por la PROPIA pantalla (nunca por el admin)
  audioInfo?: {
    devices: { deviceId: string; label: string }[]
    supportsSinkId: boolean
    reportedAt: number
  }
}

const screens = new Map<string, ScreenEntry>() // key: socketId
const admins = new Map<string, AdminIdentity>() // key: socketId

// Puerto 3003: socket.io puro (los endpoints HTTP los maneja el servidor interno en 3004)
const io = new Server(createServer(), {
  path: "/",
  cors: {
    origin: (origin, cb) => {
      // El host del handshake no está disponible en este callback; se valida
      // por host del origin: privados/LAN + explícitos. La coincidencia exacta
      // con el Host de la petición se cubre en connectionAllowed().
      cb(null, originAllowed(origin, undefined, ALLOWED_ORIGINS))
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

/** Segunda capa CORS: origen cuyo host NO coincide con el Host del handshake
 *  ni es privado ni está configurado → se desconecta de inmediato. */
function connectionAllowed(socket: Socket): boolean {
  const origin = socket.handshake.headers.origin
  const host = socket.handshake.headers.host
  return originAllowed(origin, host, ALLOWED_ORIGINS)
}

function snapshot() {
  return Array.from(screens.values()).map((s) => ({
    screenCode: s.screenCode,
    verified: s.verified,
    resolution: s.resolution,
    userAgent: s.userAgent,
    connectedAt: s.connectedAt,
    lastSeen: s.lastSeen,
    online: Date.now() - s.lastSeen < OFFLINE_AFTER_MS,
    streamState: s.streamState,
    streamInfo: s.streamInfo,
    audioInfo: s.audioInfo ?? null,
  }))
}

function emitToTarget(event: string, payload: unknown, target?: string, screenCode?: string) {
  if (target === "admins") return io.to("admins").emit(event, payload)
  if (target === "screens") {
    const safe = sanitizeForScreens(payload)
    if (screenCode) {
      for (const s of screens.values()) {
        if (s.screenCode === screenCode) io.to(s.socketId).emit(event, safe)
      }
    } else {
      io.to("screens").emit(event, safe)
    }
    return
  }
  // target "all" (o vacío): admins reciben todo; pantallas reciben el payload saneado
  io.to("admins").emit(event, payload)
  io.to("screens").emit(event, sanitizeForScreens(payload))
}

function pushSnapshotToAdmins() {
  io.to("admins").emit("screens:snapshot", { screens: snapshot(), ts: Date.now() })
}

// ---------- Handshake: identidad admin desde la cookie de sesión ----------
function adminFromHandshake(socket: Socket): AdminIdentity | null {
  const cookie = parseCookie(socket.handshake.headers.cookie as string | undefined, SESSION_COOKIE)
  if (!cookie) return null
  const payload = verifySessionToken(cookie, AUTH_SECRET)
  if (!payload) return null
  const user = findUser(payload.uid)
  return checkAdminSession(payload, user)
}

io.on("connection", (socket: Socket) => {
  // Capa 2 CORS (host del handshake) + identidad admin del handshake
  if (!connectionAllowed(socket)) {
    socket.disconnect(true)
    return
  }
  const admin = adminFromHandshake(socket)

  // ---------- Pantallas TV ----------
  socket.on(
    "screen:register",
    (data: { screenCode: string; resolution: string; userAgent: string; token?: string }) => {
      const code = String(data?.screenCode || "").trim()
      const auth = checkScreenAuth(code, data?.token ? String(data.token) : undefined, findScreen(code))
      if (!auth.ok) {
        // Código inventado, pantalla inactiva o token incorrecto → RECHAZO
        const reason = auth.reason === "unknown" ? "pantalla no reconocida" : auth.reason === "inactive" ? "pantalla inactiva" : "token de pantalla inválido"
        console.log(`⛔ [realtime] Registro de pantalla RECHAZADO (${code || "?"}): ${reason}`)
        socket.emit("screen:rejected", { reason: auth.reason, message: reason })
        return
      }
      socket.join("screens")
      screens.set(socket.id, {
        socketId: socket.id,
        screenCode: code,
        verified: auth.verified,
        resolution: data.resolution,
        userAgent: data.userAgent,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        streamState: "connecting",
        streamInfo: {},
      })
      persistLastSeen(code)
      pushSnapshotToAdmins()
      socket.emit("screen:registered", { ok: true, screenCode: code, verified: auth.verified })
    }
  )

  socket.on("screen:heartbeat", (data: { resolution?: string }) => {
    const s = screens.get(socket.id)
    if (s) {
      s.lastSeen = Date.now()
      if (data.resolution) s.resolution = data.resolution
      persistLastSeen(s.screenCode)
    }
  })

  // FASE 7: la pantalla reporta SUS dispositivos de audio (enumerados en su
  // propio navegador) + si soporta setSinkId. El admin elige de esta lista.
  socket.on("screen:audio", (data: { devices?: { deviceId: string; label: string }[]; supportsSinkId?: boolean }) => {
    const s = screens.get(socket.id)
    if (s && Array.isArray(data?.devices)) {
      s.audioInfo = {
        devices: data.devices.slice(0, 16).map((d) => ({
          deviceId: String(d.deviceId ?? "").slice(0, 128),
          label: String(d.label ?? "").slice(0, 80) || "Dispositivo",
        })),
        supportsSinkId: Boolean(data.supportsSinkId),
        reportedAt: Date.now(),
      }
      pushSnapshotToAdmins()
    }
  })

  socket.on("stream:report", (data: {
    state: ScreenEntry["streamState"]
    resolution?: string
    bitrate?: number
    latency?: number
    uptime?: number
    reconnects?: number
  }) => {
    const s = screens.get(socket.id)
    if (s) {
      s.streamState = data.state
      s.streamInfo = {
        resolution: data.resolution ?? s.streamInfo.resolution,
        bitrate: data.bitrate ?? s.streamInfo.bitrate,
        latency: data.latency ?? s.streamInfo.latency,
        uptime: data.uptime ?? s.streamInfo.uptime,
        reconnects: data.reconnects ?? s.streamInfo.reconnects,
      }
      io.to("admins").emit("stream:status", {
        screenCode: s.screenCode,
        state: s.streamState,
        ...s.streamInfo,
      })
    }
  })

  // ---------- Admin (EXIGE sesión válida en el handshake) ----------
  socket.on("admin:register", () => {
    if (!admin) {
      console.log("⛔ [realtime] admin:register SIN sesión válida — rechazado")
      socket.emit("admin:rejected", { message: "Sesión de administración no válida" })
      return
    }
    if (admin.role !== "ADMIN" && admin.role !== "OPERATOR" && admin.role !== "VIEWER") {
      socket.emit("admin:rejected", { message: "Rol sin acceso" })
      return
    }
    socket.join("admins")
    admins.set(socket.id, admin)
    socket.emit("screens:snapshot", { screens: snapshot(), ts: Date.now() })
  })

  socket.on("admin:command", (data: { type: string; screenCode?: string; payload?: unknown }) => {
    const identity = admins.get(socket.id)
    if (!identity) {
      console.log(`⛔ [realtime] admin:command sin autenticar desde ${socket.handshake.address ?? "?"} — ignorado`)
      socket.emit("admin:rejected", { message: "No autenticado" })
      return
    }
    // Solo roles operativos pueden enviar comandos (VIEWER observa)
    if (identity.role !== "ADMIN" && identity.role !== "OPERATOR") {
      socket.emit("admin:rejected", { message: "Rol sin permiso para comandos" })
      return
    }
    // Comandos: reload | fullscreen | audio ... (payload ya validado por el backend Next.js)
    emitToTarget("screen:command", data, "screens", data.screenCode)
  })

  // ---------- Ciclo de vida ----------
  socket.on("disconnect", () => {
    const wasScreen = screens.delete(socket.id)
    admins.delete(socket.id)
    if (wasScreen) pushSnapshotToAdmins()
  })

  socket.on("error", (err: Error) => console.error(`[ws] socket error:`, err.message))
})

// Sweeper: marca pantallas sin heartbeat y notifica a admins
setInterval(() => {
  let changed = false
  const now = Date.now()
  for (const s of screens.values()) {
    if (now - s.lastSeen > OFFLINE_AFTER_MS && s.streamState !== "offline") {
      s.streamState = "offline"
      changed = true
    }
  }
  if (changed) pushSnapshotToAdmins()
  // heartbeat de pantallas también refresca snapshot cada 30s
  if (now % 30_000 < 1_000) pushSnapshotToAdmins()
}, 15_000)

// Servidor socket.io (3003) — usado por navegadores vía Caddy o LAN directa
io.listen(PORT)

// ---------- Servidor HTTP interno (3004, localhost) ----------
const internalServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // La API interna es localhost-only (bind 127.0.0.1); el navegador nunca la toca.
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-internal-token")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    return res.end()
  }

  // FASE 6: health real para el backend y el supervisor
  if (req.method === "GET" && req.url?.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    return res.end(
      JSON.stringify({
        ok: true,
        service: "realtime-service",
        uptimeSec: Math.floor(process.uptime()),
        socketPort: PORT,
        screensOnline: screens.size,
        adminsOnline: admins.size,
        ts: Date.now(),
      })
    )
  }

  if (req.method === "GET" && req.url?.startsWith("/status")) {
    // no-store: los clientes (incl. fetch de bun) NO deben cachear estado vivo
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    return res.end(
      JSON.stringify({
        ok: true,
        uptime: Math.floor(process.uptime()),
        screensOnline: screens.size,
        adminsOnline: admins.size,
        screens: snapshot(),
      })
    )
  }

  if (req.method === "POST" && req.url?.startsWith("/broadcast")) {
    if (req.headers["x-internal-token"] !== INTERNAL_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: "unauthorized" }))
    }
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try {
        const { event, payload, target, screenCode } = JSON.parse(body || "{}")
        emitToTarget(event, payload, target, screenCode)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, event, delivered: true }))
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "bad request" }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end("not found")
})

internalServer.listen(INTERNAL_PORT, "127.0.0.1", () => {
  console.log(`✅ Realtime service: socket.io en ${PORT} · API interna en ${INTERNAL_PORT}`)
  console.log(`   Auth admin: cookie de sesión (HMAC+authVersion) · Pantallas: token pairing (sha256)`)
})

process.on("SIGTERM", () => {
  io.close()
  internalServer.close(() => process.exit(0))
})
process.on("SIGINT", () => {
  io.close()
  internalServer.close(() => process.exit(0))
})

export { sha256Hex } // re-export para tests
