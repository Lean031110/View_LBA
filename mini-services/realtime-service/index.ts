/**
 * Realtime Service — ViewLBA
 * ---------------------------
 * Hub Socket.io (puerto 3003) que conecta:
 *   - Pantallas TV (room "screens")  → heartbeat, métricas, estado del stream
 *   - Paneles Admin  (room "admins") → snapshots de pantallas, estado del stream
 *
 * El Next.js API llama a POST /broadcast (con token interno) para notificar
 * cambios de contenido a las pantallas en tiempo real.
 */
import { createServer, IncomingMessage, ServerResponse } from "http"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Server, Socket } from "socket.io"

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

const PORT = 3003 // Socket.io (navegadores, vía Caddy)
const INTERNAL_PORT = 3004 // API interna (solo localhost, llamado desde Next.js)
const INTERNAL_TOKEN = requireRealtimeToken()
const OFFLINE_AFTER_MS = 45_000 // sin heartbeat → pantalla offline

interface ScreenEntry {
  socketId: string
  screenCode: string
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
}

const screens = new Map<string, ScreenEntry>() // key: socketId
const admins = new Set<string>() // socketIds

// Puerto 3003: socket.io puro (los endpoints HTTP los maneja el servidor interno en 3004)
const io = new Server(createServer(), {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

function snapshot() {
  return Array.from(screens.values()).map((s) => ({
    screenCode: s.screenCode,
    resolution: s.resolution,
    userAgent: s.userAgent,
    connectedAt: s.connectedAt,
    lastSeen: s.lastSeen,
    online: Date.now() - s.lastSeen < OFFLINE_AFTER_MS,
    streamState: s.streamState,
    streamInfo: s.streamInfo,
  }))
}

function emitToTarget(event: string, payload: unknown, target?: string, screenCode?: string) {
  if (target === "admins") return io.to("admins").emit(event, payload)
  if (target === "screens") {
    if (screenCode) {
      // Solo a la pantalla indicada
      for (const s of screens.values()) {
        if (s.screenCode === screenCode) io.to(s.socketId).emit(event, payload)
      }
    } else {
      io.to("screens").emit(event, payload)
    }
    return
  }
  io.emit(event, payload)
}

function pushSnapshotToAdmins() {
  io.to("admins").emit("screens:snapshot", { screens: snapshot(), ts: Date.now() })
}

io.on("connection", (socket: Socket) => {
  // ---------- Pantallas TV ----------
  socket.on("screen:register", (data: { screenCode: string; resolution: string; userAgent: string }) => {
    socket.join("screens")
    screens.set(socket.id, {
      socketId: socket.id,
      screenCode: data.screenCode || "UNKNOWN",
      resolution: data.resolution,
      userAgent: data.userAgent,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      streamState: "connecting",
      streamInfo: {},
    })
    pushSnapshotToAdmins()
    socket.emit("screen:registered", { ok: true, screenCode: data.screenCode })
  })

  socket.on("screen:heartbeat", (data: { resolution?: string }) => {
    const s = screens.get(socket.id)
    if (s) {
      s.lastSeen = Date.now()
      if (data.resolution) s.resolution = data.resolution
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

  // ---------- Admin ----------
  socket.on("admin:register", () => {
    socket.join("admins")
    admins.add(socket.id)
    socket.emit("screens:snapshot", { screens: snapshot(), ts: Date.now() })
  })

  socket.on("admin:command", (data: { type: string; screenCode?: string; payload?: unknown }) => {
    // Comandos: reload | fullscreen | audio | ticker-pause ...
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

// Servidor socket.io (3003) — usado por navegadores vía Caddy
io.listen(PORT)

// ---------- Servidor HTTP interno (3004, localhost) ----------
const internalServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    return res.end()
  }

  if (req.method === "GET" && req.url?.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json" })
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
})

process.on("SIGTERM", () => {
  io.close()
  internalServer.close(() => process.exit(0))
})
process.on("SIGINT", () => {
  io.close()
  internalServer.close(() => process.exit(0))
})
