import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"

const SPEC = {
  title: "s",
  description: "s?",
  price: "s?",
  oldPrice: "s?",
  discount: "s?",
  badge: "s?",
  imageUrl: "s?",
  startDate: "d?",
  endDate: "d?",
  startTime: "s?",
  endTime: "s?",
  duration: "n",
  priority: "n",
  order: "n",
  active: "b",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const data = pickFields(await readBody(req), SPEC)
  const item = await db.promotion.update({ where: { id }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Promoción no encontrada" }, { status: 404 })
  await logAction(auth, "UPDATE", "promotions", item.title)
  await notifyContentUpdate("promotions")
  return NextResponse.json({ item })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const item = await db.promotion.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Promoción no encontrada" }, { status: 404 })
  await logAction(auth, "DELETE", "promotions", item.title)
  await notifyContentUpdate("promotions")
  return NextResponse.json({ ok: true })
}
