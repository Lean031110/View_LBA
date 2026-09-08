import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"

const SPEC = {
  text: "s",
  order: "n",
  active: "b",
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const items = await db.tickerMessage.findMany({ orderBy: [{ order: "asc" }] })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  if (!data.text) return NextResponse.json({ error: "Texto requerido" }, { status: 400 })
  const item = await db.tickerMessage.create({ data: data as never })
  await logAction(auth, "CREATE", "ticker", String(data.text).slice(0, 80))
  await notifyContentUpdate("ticker")
  return NextResponse.json({ item })
}
