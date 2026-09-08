import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"
import { validateData, scheduleCreate } from "@/lib/validators"

const SPEC = {
  name: "s",
  startTime: "s",
  endTime: "s",
  dayOfWeek: "n?",
  icon: "s?",
  color: "s?",
  order: "n",
  active: "b",
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const items = await db.schedule.findMany({ orderBy: [{ order: "asc" }] })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const data = pickFields(await readBody(req), SPEC)
  const v = validateData(scheduleCreate, data)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  if (!data.name || !data.startTime || !data.endTime) {
    return NextResponse.json({ error: "Nombre, hora inicio y fin requeridos" }, { status: 400 })
  }
  const item = await db.schedule.create({ data: data as never })
  await logAction(auth, "CREATE", "schedules", String(data.name))
  await notifyContentUpdate("schedules")
  return NextResponse.json({ item })
}
