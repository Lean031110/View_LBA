import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"

const SPEC = {
  code: "s",
  name: "s",
  location: "s?",
  notes: "s?",
  active: "b",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const data = pickFields(await readBody(req), SPEC)
  const item = await db.screen.update({ where: { id }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Pantalla no encontrada" }, { status: 404 })
  await logAction(auth, "UPDATE", "screens", item.code)
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
