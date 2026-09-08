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

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const items = await db.promotion.findMany({ orderBy: [{ order: "asc" }] })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  if (!data.title) return NextResponse.json({ error: "Título requerido" }, { status: 400 })
  const item = await db.promotion.create({ data: data as never })
  await logAction(auth, "CREATE", "promotions", String(data.title))
  await notifyContentUpdate("promotions")
  return NextResponse.json({ item })
}
