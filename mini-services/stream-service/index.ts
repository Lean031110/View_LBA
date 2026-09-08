/**
 * STREAM SERVICE — Servidor de transmisión RTMP integrado (100% LAN, sin Internet)
 * ================================================================================
 * Flujo:  OBS Studio ──rtmp://IP-LAN:1935/live+CLAVE──▶ este servicio
 *             ├─ RTMP ingest  : 1935 (node-media-server v4, GOP cache)
 *             ├─ HTTP-FLV     : 8000 (/live/<clave>.flv — playback)
 *             ├─ Control      : 127.0.0.1:8100 (solo localhost)
 *             │     POST /nms-notify → validación de clave (403 = rechazo, OBS desconectado)
 *             │     GET  /status     → estado para el proxy de Next.js (sin exponer la clave)
 *             │     GET  /health     → para el supervisor
 *             └─ Notifica 'stream:server' al realtime-service (:3004) → TVs + admins
 *
 * La clave se lee de SQLite (Settings.streamKey) cada 2s: si el admin la rota
 * desde el panel, el servidor la aplica sin reiniciarse (para nuevas conexiones).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { connect as tcpConnect } from "net"
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { resolve } from "path"
import { createRequire } from "module"
import NodeMediaServer from "node-media-server"

// ---------- Configuración de entorno (robusta: parsea .env directamente) ----------
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
// Raíz del proyecto (portable: funciona desde un clone en cualquier ruta)
const ROOT_DIR = resolve(import.meta.dir, "..", "..")

/** Resuelve la URL `file:` de Prisma con su misma semántica (relativa a prisma/schema.prisma) */
function resolveDbPath(url: string): string {
  const raw = url.replace(/^file:/, "")
  return raw.startsWith("/") ? raw : resolve(ROOT_DIR, "prisma", raw)
}

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
    log("✗ REALTIME_TOKEN inválido o ausente. Genera uno real (openssl rand -hex 16) y ponlo en .env del raíz del proyecto.")
    process.exit(1)
  }
  return t
}

const REALTIME_TOKEN = requireRealtimeToken()
const REALTIME_URL = "http://127.0.0.1:3004/broadcast"
const DB_PATH = resolveDbPath(ENV.DATABASE_URL || `file:${resolve(ROOT_DIR, "db", "custom.db")}`)

const RTMP_PORT = Number(ENV.RTMP_PORT || 1935)
const HTTP_FLV_PORT = Number(ENV.HTTP_FLV_PORT || 8000)
const CONTROL_PORT = 8100 // interno, solo localhost

const log = (...a: unknown[]) => console.log(`[stream-service ${new Date().toISOString().slice(11, 19)}]`, ...a)

// ---------- Lectura de la clave de transmisión desde SQLite ----------
let dbHandle: Database | null = null
let currentKey: string | null = null
let currentApp = "live"

function openDb(): Database | null {
  try {
    dbHandle = new Database(DB_PATH, { readonly: true })
    return dbHandle
  } catch (e) {
    log("⚠ No se pudo abrir SQLite:", (e as Error).message)
    return null
  }
}

function refreshStreamConfig() {
  try {
    const db = dbHandle ?? openDb()
    if (!db) return
    const row = db.query("SELECT streamKey, rtmpApp FROM Settings WHERE id = 'main'").get() as
      | { streamKey: string | null; rtmpApp: string | null }
      | undefined
    if (row) {
      const newKey = row.streamKey?.trim() || null
      if (newKey !== currentKey) {
        currentKey = newKey
        log(newKey ? `🔑 Clave de transmisión actualizada (${newKey.slice(0, 4)}****)` : "⚠ Sin clave configurada — publicaciones rechazadas")
      }
      currentApp = row.rtmpApp || "live"
    }
  } catch {
    // La BD puede estar momentáneamente bloqueada (migración) → conservar último valor
    try {
      dbHandle?.close()
    } catch {}
    dbHandle = null
  }
}
refreshStreamConfig()
setInterval(refreshStreamConfig, 2000).unref()

// ---------- Estado del servidor de streaming ----------
interface LastSession {
  startedAt: number | null
  endedAt: number
  ip: string | null
  inBytes: number
  outBytes: number
}
const state = {
  live: false,
  since: null as number | null,
  sessionId: null as string | null,
  publisherIp: null as string | null,
  viewers: 0,
  lastSession: null as LastSession | null,
  startedAt: Date.now(),
}
const playSessions = new Set<string>()
let graceTimer: ReturnType<typeof setTimeout> | null = null
let lastViewersBroadcast = 0

// ---------- Difusión de estado al realtime-service (TVs + admins) ----------
async function broadcastStream() {
  const payload = {
    source: "local",
    live: state.live,
    since: state.since,
    viewers: state.viewers,
    publisherIp: state.publisherIp,
    serverUptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    ts: Date.now(),
  }
  try {
    await fetch(REALTIME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": REALTIME_TOKEN },
      body: JSON.stringify({ event: "stream:server", payload, target: "all" }),
      signal: AbortSignal.timeout(2500),
    })
  } catch {
    // realtime-service no disponible: las pantallas usan polling de respaldo
  }
}
function broadcastViewersThrottled() {
  const now = Date.now()
  if (now - lastViewersBroadcast > 1000) {
    lastViewersBroadcast = now
    broadcastStream()
  }
}

// ---------- Servidor de control (localhost:8100) ----------
const controlServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", "http://127.0.0.1")

  // ---- Hook de node-media-server: validación de la clave de publicación ----
  if (req.method === "POST" && url.pathname === "/nms-notify") {
    let body = ""
    for await (const chunk of req) body += chunk as string
    let data: Record<string, unknown>
    try {
      data = JSON.parse(body || "{}")
    } catch {
      res.writeHead(400)
      return res.end("bad json")
    }
    const action = String(data.action || "")
    const id = String(data.id || "")
    const ip = String(data.ip || "")
    const app = String(data.app || "")
    const name = String(data.name || "")

    // prePublish: aquí se decide si OBS puede publicar.
    // Responder ≠200 → node-media-server cierra la sesión (rechazo limpio).
    if (action === "prePublish") {
      const valid = Boolean(currentKey) && app === currentApp && name === currentKey
      if (!valid) {
        log(`⛔ Publicación RECHAZADA desde ${ip || "?"} · ${app}/${name ? name.slice(0, 4) + "****" : "(sin nombre)"} · clave incorrecta`)
        res.writeHead(403, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ ok: false, reason: "invalid-stream-key" }))
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ ok: true }))
    }

    if (action === "postPublish") {
      // Segundo publicador sobre la misma ruta → NMS lo rechaza ("already has a publisher")
      if (state.live && state.sessionId && state.sessionId !== id) {
        res.writeHead(200)
        return res.end("ok")
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      state.live = true
      state.since = Number(data.createtime) || Date.now()
      state.sessionId = id
      state.publisherIp = ip || null
      log(`▶ EN VIVO — publicador ${ip || "?"} · sesión ${id} · ${app}/${currentKey?.slice(0, 4)}****`)
      broadcastStream()
      res.writeHead(200)
      return res.end("ok")
    }

    if (action === "donePublish") {
      if (state.sessionId === id || state.live) {
        state.lastSession = {
          startedAt: state.since,
          endedAt: Date.now(),
          ip: state.publisherIp,
          inBytes: Number(data.inbytes) || 0,
          outBytes: Number(data.outbytes) || 0,
        }
        // Gracia breve: OBS puede reconectar en segundos (reanudación)
        if (graceTimer) clearTimeout(graceTimer)
        graceTimer = setTimeout(() => {
          state.live = false
          state.since = null
          state.sessionId = null
          state.publisherIp = null
          log("■ Publicación finalizada — esperando OBS")
          broadcastStream()
        }, 2500)
      }
      res.writeHead(200)
      return res.end("ok")
    }

    if (action === "postPlay") {
      if (id) playSessions.add(id)
      state.viewers = playSessions.size
      broadcastViewersThrottled()
      res.writeHead(200)
      return res.end("ok")
    }
    if (action === "donePlay") {
      playSessions.delete(id)
      state.viewers = playSessions.size
      broadcastViewersThrottled()
      res.writeHead(200)
      return res.end("ok")
    }

    res.writeHead(200)
    return res.end("ok")
  }

  // ---- Estado (sin material secreto) ----
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    return res.end(
      JSON.stringify({
        ok: true,
        service: "stream-service",
        live: state.live,
        since: state.since,
        viewers: state.viewers,
        publisherIp: state.publisherIp,
        lastSession: state.lastSession,
        hasKey: Boolean(currentKey),
        rtmp: { port: RTMP_PORT, app: currentApp },
        httpFlv: { port: HTTP_FLV_PORT },
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
        ts: Date.now(),
      })
    )
  }

  if (req.method === "GET" && url.pathname === "/health") {
    // FASE 13: health REAL — comprueba que los listeners de NMS están vivos
    // (un proceso zombi con /health plano daría falso positivo al supervisor)
    const [rtmpAlive, flvAlive] = await Promise.all([tcpListenerAlive(RTMP_PORT), tcpListenerAlive(HTTP_FLV_PORT)])
    const ok = rtmpAlive
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    return res.end(
      JSON.stringify({
        ok,
        service: "stream-service",
        rtmpListening: rtmpAlive,
        httpFlvListening: flvAlive,
        live: state.live,
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
        ts: Date.now(),
      })
    )
  }

  res.writeHead(404)
  res.end("not found")
})

controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
  log(`🎛 Control interno escuchando en 127.0.0.1:${CONTROL_PORT}`)
})

// ---------- node-media-server: RTMP + HTTP-FLV ----------
const nms = new NodeMediaServer({
  bind: "0.0.0.0", // RTMP debe aceptar OBS desde la LAN
  notify: { url: `http://127.0.0.1:${CONTROL_PORT}/nms-notify` },
  store: { path: "./data" },
  auth: { play: false, publish: false }, // la clave la valida /nms-notify contra SQLite
  rtmp: { port: RTMP_PORT },
  http: { port: HTTP_FLV_PORT },
})

/** ¿Un puerto TCP local está escuchando? (para /health real) */
function tcpListenerAlive(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = tcpConnect(port, "127.0.0.1")
    sock.setTimeout(800)
    sock.on("connect", () => {
      sock.destroy()
      res(true)
    })
    sock.on("error", () => res(false))
    sock.on("timeout", () => {
      sock.destroy()
      res(false)
    })
  })
}

// Doble capa de validación (defense in depth): si el hook notify fallara,
// este listener también corta publicaciones con clave incorrecta.
nms.on("prePublish", (session) => {
  if (!currentKey || session.streamApp !== currentApp || session.streamName !== currentKey) {
    log(`⛔ [evento] Publicación rechazada: ${session.streamPath} desde ${session.ip}`)
    try {
      session.close()
    } catch {}
  }
})
nms.on("postPublish", (session) => {
  log(`✅ [evento] Publicación aceptada · ${session.protocol} · ${session.ip} · codec=${session.videoCodec} ${session.videoWidth}×${session.videoHeight}`)
})
nms.on("donePublish", () => log("✅ [evento] Publicador desconectado"))

// Reducir verbosidad del logger interno (debug → info)
try {
  const require2 = createRequire(import.meta.url)
  const loggerModule = require2("node-media-server/src/core/logger.js") as { level?: string }
  if (loggerModule && typeof loggerModule.level === "string") loggerModule.level = "info"
} catch {}

// ---------- Arranque ----------
async function main() {
  await nms.run()
  // FASE 13: HTTP-FLV re-vinculado a 127.0.0.1 (NMS v4 usa bind global, que
  // debe ser 0.0.0.0 para el RTMP de OBS). Las TVs reproducen vía el proxy
  // /api/stream/live.flv — NADIE necesita :8000 desde la red. Configurable
  // con HTTP_FLV_BIND=0.0.0.0 para despliegues con clientes FLV directos.
  const flvBind = ENV.HTTP_FLV_BIND || "127.0.0.1"
  if (flvBind !== "0.0.0.0") {
    const rawHttp = (nms as unknown as { httpServer?: { httpServer?: { close: () => void; listen: (p: number, h: string, cb: () => void) => void } } }).httpServer?.httpServer
    if (rawHttp) {
      await new Promise<void>((res) => rawHttp.close(() => res()))
      await new Promise<void>((res) => rawHttp.listen(HTTP_FLV_PORT, flvBind, () => res()))
      log(`🔒 HTTP-FLV re-vinculado a ${flvBind}:${HTTP_FLV_PORT} (solo proxy Next.js)`)
    }
  }
  log(`🚀 Servidor de transmisión LISTO (LAN)`)
  log(`   RTMP ingest : rtmp://<IP-DE-ESTE-EQUIPO>:${RTMP_PORT}/${currentApp}`)
  log(`   HTTP-FLV    : http://${flvBind}:${HTTP_FLV_PORT}/${currentApp}/<clave>.flv`)
  log(`   Clave       : ${currentKey ? currentKey.slice(0, 4) + "****" : "(no configurada — generar desde el panel)"}`)
  broadcastStream()
  // Refresco periódico para admins (uptime / viewers)
  setInterval(() => broadcastStream(), 10_000).unref()
}

main().catch((e) => {
  log("💥 Error fatal arrancando node-media-server:", e)
  process.exit(1)
})

// ---------- Cierre limpio ----------
process.on("SIGTERM", async () => {
  if (graceTimer) clearTimeout(graceTimer)
  try {
    await nms.stop()
  } catch {}
  process.exit(0)
})
process.on("SIGINT", async () => {
  if (graceTimer) clearTimeout(graceTimer)
  try {
    await nms.stop()
  } catch {}
  process.exit(0)
})
