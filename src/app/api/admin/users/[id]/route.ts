import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse, hashPassword } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"

const SPEC = {
  email: "s",
  name: "s",
  role: "s",
  active: "b",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const body = await readBody(req)
  const data = pickFields(body, SPEC)
  if (data.role && !["ADMIN", "OPERATOR", "VIEWER"].includes(String(data.role))) {
    return NextResponse.json({ error: "Rol no válido" }, { status: 400 })
  }
  if (data.email) data.email = String(data.email).toLowerCase().trim()

  const updateData: Record<string, unknown> = { ...data }
  if (body.password) updateData.passwordHash = hashPassword(String(body.password))
  // Evitar auto-degradación: un admin no puede quitarse su propio rol
  if (id === auth.uid && data.role && data.role !== "ADMIN") {
    return NextResponse.json({ error: "No puedes cambiar tu propio rol de administrador" }, { status: 400 })
  }

  const item = await db.user
    .update({ where: { id }, data: updateData as never })
    .catch(() => null)
  if (!item) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })
  await logAction(auth, "UPDATE", "users", item.email)
  return NextResponse.json({ item: { id: item.id, email: item.email, name: item.name, role: item.role, active: item.active } })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  if (id === auth.uid) return NextResponse.json({ error: "No puedes eliminar tu propio usuario" }, { status: 400 })
  const adminsLeft = await db.user.count({ where: { role: "ADMIN", active: true, NOT: { id } } })
  const target = await db.user.findUnique({ where: { id } })
  if (target?.role === "ADMIN" && adminsLeft === 0) {
    return NextResponse.json({ error: "Debe existir al menos un administrador activo" }, { status: 400 })
  }
  const item = await db.user.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })
  await logAction(auth, "DELETE", "users", item.email)
  return NextResponse.json({ ok: true })
}
