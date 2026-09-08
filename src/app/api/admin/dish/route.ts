import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"

const SPEC = {
  name: "s",
  description: "s?",
  price: "s?",
  imageUrl: "s?",
  ingredients: "s?",
  tag: "s?",
  nutrition: "s?",
  dayOfWeek: "n?",
  date: "d?",
  order: "n",
  active: "b",
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const items = await db.dish.findMany({ orderBy: [{ order: "asc" }] })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  if (!data.name) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 })
  const item = await db.dish.create({ data: data as never })
  await logAction(auth, "CREATE", "dish", String(data.name))
  await notifyContentUpdate("dish")
  return NextResponse.json({ item })
}
