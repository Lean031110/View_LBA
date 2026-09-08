import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { broadcast } from "@/lib/realtime"

const SPEC = {
  name: "s",
  location: "s?",
  notes: "s?",
  active: "b",
  // FASE 7: deviceId de salida de audio de ESTA pantalla (elegido de la
  // lista que reporta el propio navegador del TV)
  audioDeviceId: "s?",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const body = await readBody(req)
  const data = pickFields(body, SPEC)
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios válidos" }, { status: 400 })
  }
  const item = await db.screen.update({ where: { id }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Pantalla no encontrada" }, { status: 404 })
  await logAction(auth, "UPDATE", "screens", item.code)

  // FASE 7: si cambió la salida de audio de esta pantalla, aplicarla EN VIVO
  // (el TV valida que el deviceId pertenezca a sus propios dispositivos)
  if ("audioDeviceId" in data) {
    const s = await db.settings.findUnique({ where: { id: "main" }, select: { audioVolume: true, audioMuted: true } })
    await broadcast(
      "audio:config",
      { volume: s?.audioVolume ?? 80, muted: s?.audioMuted ?? true, deviceId: item.audioDeviceId },
      "screens",
      item.code
    )
  }
  return NextResponse.json({ item })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const item = await db.screen.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Pantalla no encontrada" }, { status: 404 })
  await logAction(auth, "DELETE", "screens", item.code)
  return NextResponse.json({ ok: true })
}
