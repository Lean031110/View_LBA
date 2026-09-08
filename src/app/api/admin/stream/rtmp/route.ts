import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { requireAuth, isNextResponse, type SessionPayload } from "@/lib/auth"
import { db } from "@/lib/db"
import { logAction } from "@/lib/crud"
import { broadcast } from "@/lib/realtime"
import { getPrimaryLanIp } from "@/lib/net"

export const dynamic = "force-dynamic"

/** GET /api/admin/stream/rtmp — Información para conectar OBS (LAN). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const user = auth as SessionPayload

  const s = await db.settings.findUnique({
    where: { id: "main" },
    select: { streamSource: true, rtmpPort: true, rtmpApp: true, rtmpHost: true, streamKey: true, streamEnabled: true },
  })
  if (!s) return NextResponse.json({ error: "Configuración no encontrada" }, { status: 404 })

  // ¿Revelar la clave completa? Solo ADMIN y explícitamente (?reveal=1)
  const wantReveal = req.nextUrl.searchParams.get("reveal") === "1" && user.role === "ADMIN"

  const host = s.rtmpHost?.trim() || getPrimaryLanIp()
  const rtmpUrl = `rtmp://${host}:${s.rtmpPort}/${s.rtmpApp}`

  // Estado del mini-servicio de streaming (localhost)
  let server: {
    ok: boolean
    live: boolean
    since: number | null
    viewers: number
    publisherIp: string | null
    hasKey: boolean
    uptimeSec: number
  } | null = null
  try {
    const res = await fetch("http://127.0.0.1:8100/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    })
    if (res.ok) server = await res.json()
  } catch {}

  const key = s.streamKey?.trim() ?? null
  return NextResponse.json(
    {
      source: s.streamSource,
      streamEnabled: s.streamEnabled,
      host,
      hostAuto: !s.rtmpHost?.trim(),
      rtmpPort: s.rtmpPort,
      rtmpApp: s.rtmpApp,
      rtmpUrl,
      hasKey: Boolean(key),
      keyMasked: key ? `••••••••${key.slice(-4)}` : null,
      // La clave completa solo con reveal+ADMIN (para copiar a OBS)
      ...(wantReveal && key ? { key } : {}),
      server,
      ts: Date.now(),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}

/** PUT /api/admin/stream/rtmp — Ajustar host/puerto/app del RTMP (persistencia). */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const data: Record<string, unknown> = {}
  if (typeof body.rtmpHost === "string") data.rtmpHost = body.rtmpHost.trim() || null
  if (typeof body.rtmpPort === "number" && body.rtmpPort > 0 && body.rtmpPort < 65536) data.rtmpPort = Math.floor(body.rtmpPort)
  if (typeof body.rtmpApp === "string" && /^[a-z0-9_-]{1,24}$/i.test(body.rtmpApp.trim())) data.rtmpApp = body.rtmpApp.trim()
  if (typeof body.streamSource === "string" && ["local", "external"].includes(body.streamSource)) data.streamSource = body.streamSource

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios válidos" }, { status: 400 })
  }

  const item = await db.settings.update({ where: { id: "main" }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Error guardando" }, { status: 500 })

  await logAction(auth as SessionPayload, "UPDATE", "transmisión", `rtmp: ${Object.keys(data).join(",")}`)
  await broadcast("content:update", { section: "settings", ts: Date.now() }, "screens")

  return NextResponse.json({ ok: true })
}

/** POST /api/admin/stream/rtmp — Regenerar la clave de transmisión (ADMIN). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth

  const newKey = randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 24) || randomBytes(18).toString("hex").slice(0, 24)
  const item = await db.settings.update({ where: { id: "main" }, data: { streamKey: newKey } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Error regenerando la clave" }, { status: 500 })

  await logAction(auth as SessionPayload, "UPDATE", "transmisión", "clave de stream regenerada")
  // El stream-service la recarga de SQLite en ≤2s (para NUEVAS conexiones OBS)
  await broadcast("stream:server", { keyRotated: true, ts: Date.now() }, "admins")

  return NextResponse.json({ ok: true, key: newKey, keyMasked: `••••••••${newKey.slice(-4)}` })
}
