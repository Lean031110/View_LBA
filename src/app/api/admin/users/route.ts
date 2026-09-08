import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { hashPassword } from "@/lib/auth"

const SPEC = {
  email: "s",
  name: "s",
  role: "s",
  active: "b",
}

export async function GET() {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const items = await db.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
  })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const body = await readBody(req)
  const data = pickFields(body, SPEC)
  const password = String(body.password ?? "")
  if (!data.email || !data.name || !password) {
    return NextResponse.json({ error: "Email, nombre y contraseña requeridos" }, { status: 400 })
  }
  if (!["ADMIN", "OPERATOR", "VIEWER"].includes(String(data.role))) {
    return NextResponse.json({ error: "Rol no válido" }, { status: 400 })
  }
  const email = String(data.email).toLowerCase().trim()
  const exists = await db.user.findUnique({ where: { email } })
  if (exists) return NextResponse.json({ error: "Ya existe un usuario con ese email" }, { status: 409 })
  const item = await db.user.create({
    data: { email, name: String(data.name), role: String(data.role), passwordHash: hashPassword(password) },
  })
  await logAction(auth, "CREATE", "users", email)
  return NextResponse.json({ item: { id: item.id, email: item.email, name: item.name, role: item.role, active: item.active } })
}
