import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
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

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const [screens, live] = await Promise.all([db.screen.findMany({ orderBy: { code: "asc" } }), liveStatus()])
  const liveByCode = new Map(live.map((l) => [l.screenCode, l]))
  const items = screens.map((s) => ({
    ...s,
    online: liveByCode.get(s.code)?.online ?? false,
    live: liveByCode.get(s.code) ?? null,
  }))
  return NextResponse.json({ items, realtimeOnline: live.length > 0 || screens.length >= 0 })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  if (!data.code || !data.name) return NextResponse.json({ error: "Código y nombre requeridos" }, { status: 400 })
  const exists = await db.screen.findUnique({ where: { code: String(data.code) } })
  if (exists) return NextResponse.json({ error: "Ya existe una pantalla con ese código" }, { status: 409 })
  const item = await db.screen.create({ data: data as never })
  await logAction(auth, "CREATE", "screens", String(data.code))
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
  await logAction(auth, "COMMAND", "screens", `${command}${screenCode ? ` → ${screenCode}` : " → todas"}`)
  return NextResponse.json({ ok: true })
}
