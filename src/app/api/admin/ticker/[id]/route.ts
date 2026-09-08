import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"

const SPEC = {
  text: "s",
  order: "n",
  active: "b",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const data = pickFields(await readBody(req), SPEC)
  const item = await db.tickerMessage.update({ where: { id }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Mensaje no encontrado" }, { status: 404 })
  await logAction(auth, "UPDATE", "ticker", item.text.slice(0, 80))
  await notifyContentUpdate("ticker")
  return NextResponse.json({ item })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const item = await db.tickerMessage.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Mensaje no encontrado" }, { status: 404 })
  await logAction(auth, "DELETE", "ticker", item.text.slice(0, 80))
  await notifyContentUpdate("ticker")
  return NextResponse.json({ ok: true })
}
