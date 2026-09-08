import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"

const SPEC = {
  network: "s",
  username: "s?",
  url: "s?",
  color: "s?",
  order: "n",
  active: "b",
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const items = await db.socialLink.findMany({ orderBy: [{ order: "asc" }] })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  if (!data.network) return NextResponse.json({ error: "Red requerida" }, { status: 400 })
  const item = await db.socialLink.create({ data: data as never })
  await logAction(auth, "CREATE", "socials", String(data.network))
  await notifyContentUpdate("socials")
  return NextResponse.json({ item })
}
