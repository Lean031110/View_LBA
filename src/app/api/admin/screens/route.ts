import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { validateData, screenCreate } from "@/lib/validators"
import { broadcast } from "@/lib/realtime"
import type { ScreenStatus } from "@/lib/types"

const SPEC = {
  code: "s",
  name: "s",
  location: "s?",
  notes: "s?",
  active: "b",
}

async function liveStatus(): Promise<ScreenStatus[]> {
  try {
    const res = await fetch("http://127.0.0.1:3004/status", { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return []
    const data = (await res.json()) as { screens?: ScreenStatus[] }
    return data.screens ?? []
  } catch {
    return []
  }
}

/**
 * FASE 6 (misión): estado REAL del servicio realtime — se comprueba el
 * endpoint /health con timeout corto. NUNCA se infiere "online" porque
 * existan pantallas (bug anterior: `screens.length >= 0` siempre true).
 */
async function realtimeOnline(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:3004/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false // caído o timeout → false
  }
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const [screens, live, rtOnline] = await Promise.all([db.screen.findMany({ orderBy: { code: "asc" } }), liveStatus(), realtimeOnline()])
  const liveByCode = new Map(live.map((l) => [l.screenCode, l]))
  const items = screens.map((s) => ({
    ...s,
    online: rtOnline ? (liveByCode.get(s.code)?.online ?? false) : false,
    live: liveByCode.get(s.code) ?? null,
  }))
  return NextResponse.json({ items, realtimeOnline: rtOnline })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  const v = validateData(screenCreate, data)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  if (!data.code || !data.name) return NextResponse.json({ error: "Código y nombre requeridos" }, { status: 400 })
  const exists = await db.screen.findUnique({ where: { code: String(data.code) } })
  if (exists) return NextResponse.json({ error: "Ya existe una pantalla con ese código" }, { status: 409 })
  const item = await db.screen.create({ data: data as never })
  await logAction(auth, "SCREEN_CREATED", "screens", String(data.code), { resource: "screen", resourceId: item.id })
  return NextResponse.json({ item })
}

/** POST /api/admin/screens/reload — comando remoto a pantallas */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = await readBody(req)
  const command = String(body.command ?? "")
  const screenCode = body.screenCode ? String(body.screenCode) : undefined
  if (!["reload", "fullscreen", "audio"].includes(command)) {
    return NextResponse.json({ error: "Comando no válido" }, { status: 400 })
  }

  // FASE 4: el payload NO viaja tal cual a las pantallas — se valida y
  // reconstruye con esquema estricto por comando (canal cerrado, sin datos
  // arbitrarios desde el admin hacia los navegadores TV).
  let payload: Record<string, unknown> = {}
  if (command === "audio") {
    const p = (body.payload ?? {}) as Record<string, unknown>
    const volume = Number(p.volume)
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return NextResponse.json({ error: "Payload audio inválido: volume 0-100" }, { status: 400 })
    }
    const deviceId = typeof p.deviceId === "string" ? p.deviceId.slice(0, 128) : null
    payload = { volume: Math.round(volume), muted: Boolean(p.muted), deviceId }
  } else if (command === "fullscreen") {
    const p = (body.payload ?? {}) as Record<string, unknown>
    payload = { value: Boolean(p.value) }
  } else {
    payload = {}
  }

  await broadcast("screen:command", { type: command, payload }, "screens", screenCode)
  await logAction(auth, "SCREEN_COMMAND", "screens", `${command}${screenCode ? ` → ${screenCode}` : " → todas"}`, { resource: "screen", resourceId: screenCode ?? "all" })
  return NextResponse.json({ ok: true })
}
