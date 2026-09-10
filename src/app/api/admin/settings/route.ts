import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { broadcast } from "@/lib/realtime"
import { validateData, settingsUpdatePartial } from "@/lib/validators"
import { getFeatureAvailability, CONTACT_PHONE } from "@/lib/licensing"

/** Campos premium del Settings (branding + temas) — premium durante trial. */
const PREMIUM_SETTINGS_FIELDS = new Set([
  "logoUrl",
  "logoSize",
  "logoPosition",
  "primaryColor",
  "accentColor",
  "bgColor",
  "surfaceColor",
  "fontScale",
  "streamRatio",
  "animationsEnabled",
  "animationSpeed",
])

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
  // LICENSING: branding/logotipo y apariencia/temas son premium — en trial
  // se permite la configuración ESENCIAL (nombre, reloj, transmisión, audio,
  // ticker, visibilidad de módulos) pero no el branding personalizado.
  const features = await getFeatureAvailability()
  const brandingLocked = features.flags["branding.customLogo"] !== true
  const themesLocked = features.flags["themes.custom"] !== true
  const premiumTouched = Object.keys(body).filter((k) => PREMIUM_SETTINGS_FIELDS.has(k))
  if (premiumTouched.length > 0 && (brandingLocked || themesLocked)) {
    return NextResponse.json(
      {
        error: `Personalización de logotipo/temas disponible con licencia comercial (campos: ${premiumTouched.join(", ")}). Contacto: ${CONTACT_PHONE}`,
        fields: premiumTouched,
        contact: CONTACT_PHONE,
      },
      { status: 403 }
    )
  }
  const data = pickFields(body, SPEC)
  // FASE 9: validación semántica (rangos, enums, colores, URLs seguras)
  const v = validateData(settingsUpdatePartial, data)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios" }, { status: 400 })
  }
  const item = await db.settings
    .update({ where: { id: "main" }, data: data as never })
    .catch(() => null)
  if (!item) return NextResponse.json({ error: "Error guardando configuración" }, { status: 500 })

  const changed = Object.keys(data).join(",")
  await logAction(auth, "SETTINGS_CHANGED", "settings", changed, { resource: "settings", resourceId: "main", meta: { fields: Object.keys(data) } })

  // Notificar en tiempo real: contenido general + audio si cambió
  await broadcast("content:update", { section: "settings", ts: Date.now() }, "screens")
  const audioFields = ["audioVolume", "audioMuted"].some((f) => f in data)
  if (audioFields) {
    // FASE 7: el volumen/mute son globales; el deviceId de salida es POR
    // PANTALLA (ver /api/admin/screens/[id]) — ya no se emite un deviceId
    // global (pertenecía al navegador del admin: arquitectura corregida).
    await broadcast("audio:config", { volume: item.audioVolume, muted: item.audioMuted }, "screens")
  }
  return NextResponse.json({ settings: { ...item, streamKey: undefined, streamKeyMasked: maskKey(item.streamKey), hasStreamKey: Boolean(item.streamKey) } })
}
