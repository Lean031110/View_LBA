import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { broadcast } from "@/lib/realtime"

const SPEC: Record<string, string> = {
  restaurantName: "s",
  logoUrl: "s?",
  logoSize: "s",
  logoPosition: "s",
  clockFormat: "s",
  showDate: "b",
  showSeconds: "b",
  showDay: "b",
  timezone: "s",
  language: "s",
  streamSource: "s",
  rtmpPort: "n",
  rtmpApp: "s",
  rtmpHost: "s?",
  streamEnabled: "b",
  streamUrl: "s?",
  streamProtocol: "s",
  autoplay: "b",
  reconnectBehavior: "s",
  fallbackType: "s",
  fallbackMessage: "s",
  fallbackImageUrl: "s?",
  fallbackVideoUrl: "s?",
  audioVolume: "n",
  audioMuted: "b",
  audioDeviceId: "s?",
  audioAutoUnmute: "b",
  tickerEnabled: "b",
  tickerSpeed: "n",
  tickerPaused: "b",
  primaryColor: "s",
  accentColor: "s",
  bgColor: "s",
  surfaceColor: "s",
  fontScale: "n",
  streamRatio: "n",
  animationsEnabled: "b",
  animationSpeed: "n",
  showPromotions: "b",
  showDish: "b",
  showSocials: "b",
  showSchedule: "b",
  showTicker: "b",
  // FASE 4: streamKey y streamServer ELIMINADOS — la clave solo se gestiona
  // vía /api/admin/stream/rtmp (POST regeneración = ADMIN). Así un OPERATOR
  // no puede fijar una clave conocida a través de PUT /settings.
}

function maskKey(key: string | null | undefined): string | null {
  if (!key) return null
  if (key.length <= 4) return "••••"
  return `••••••••${key.slice(-4)}`
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const s = await db.settings.findUnique({ where: { id: "main" } })
  if (!s) return NextResponse.json({ error: "Configuración no encontrada" }, { status: 404 })
  // Nunca devolver la streamKey completa al frontend
  const { streamKey, ...rest } = s
  return NextResponse.json({ settings: { ...rest, streamKeyMasked: maskKey(streamKey), hasStreamKey: Boolean(streamKey) } })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = await readBody(req)
  // FASE 4: defensa explícita — streamKey por esta vía está PROHIBIDO
  if ("streamKey" in body || "streamServer" in body) {
    return NextResponse.json(
      { error: "La clave de transmisión solo se gestiona desde /api/admin/stream/rtmp" },
      { status: 400 }
    )
  }
  const data = pickFields(body, SPEC)
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios" }, { status: 400 })
  }
  const item = await db.settings
    .update({ where: { id: "main" }, data: data as never })
    .catch(() => null)
  if (!item) return NextResponse.json({ error: "Error guardando configuración" }, { status: 500 })

  const changed = Object.keys(data).join(",")
  await logAction(auth, "UPDATE", "settings", changed)

  // Notificar en tiempo real: contenido general + audio si cambió
  await broadcast("content:update", { section: "settings", ts: Date.now() }, "screens")
  const audioFields = ["audioVolume", "audioMuted", "audioDeviceId"].some((f) => f in data)
  if (audioFields) {
    await broadcast("audio:config", { volume: item.audioVolume, muted: item.audioMuted, deviceId: item.audioDeviceId }, "screens")
  }
  return NextResponse.json({ settings: { ...item, streamKey: undefined, streamKeyMasked: maskKey(item.streamKey), hasStreamKey: Boolean(item.streamKey) } })
}
