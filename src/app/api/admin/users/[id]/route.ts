import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse, hashPassword, invalidateSessionCache } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { validateData, userUpdate } from "@/lib/validators"
import { clientIp } from "@/lib/rate-limit"
import { requireLicenseFeature } from "@/lib/licensing/guard"

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
  // LICENSING: gestionar OTROS usuarios es premium; editar la PROPIA cuenta
  // (nombre/contraseña) siempre se permite — la seguridad personal no se
  // encarece (no se puede cambiar rol/active propio de todos modos).
  if (id !== auth.uid) {
    const denied = await requireLicenseFeature("users.management")
    if (denied) return denied
  }
  const body = await readBody(req)
  const data = pickFields(body, SPEC)
  if (data.email) data.email = String(data.email).toLowerCase().trim()

  // FASE 9/17: validación (contraseña solo si viene; email/rol/active con política)
  const v = validateData(userUpdate, body.password ? { ...data, password: String(body.password) } : data)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const updateData: Record<string, unknown> = { ...data }
  if (body.password) updateData.passwordHash = hashPassword(String(body.password))
  // Evitar auto-degradación: un admin no puede quitarse su propio rol
  if (id === auth.uid && data.role && data.role !== "ADMIN") {
    return NextResponse.json({ error: "No puedes cambiar tu propio rol de administrador" }, { status: 400 })
  }
  // FASE 2: desactivar al propio usuario se evita igualmente (sin sesión válida se quedaría a medias)
  if (id === auth.uid && data.active === false) {
    return NextResponse.json({ error: "No puedes desactivar tu propio usuario" }, { status: 400 })
  }

  // FASE 2 (misión): password/rol/active cambian → authVersion++ → sesiones viejas mueren
  const touchesAuth =
    Boolean(body.password) || data.role !== undefined || data.active !== undefined
  if (touchesAuth) updateData.authVersion = { increment: 1 }

  const item = await db.user
    .update({ where: { id }, data: updateData as never })
    .catch(() => null)
  if (!item) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

  // Invalidar cache de sesión inmediatamente (efecto instantáneo, sin esperar TTL 30s)
  if (touchesAuth) invalidateSessionCache(id)

  // FASE 26: vocabulario de eventos de la misión (eventos ESPECÍFICOS por cambio)
  const audit = { ip: clientIp(req), resource: "user", resourceId: item.id }
  if (body.password) {
    await logAction(auth, "PASSWORD_CHANGED", "users", `${item.email} (sesiones invalidadas)`, audit)
  } else if (data.role !== undefined) {
    await logAction(auth, "ROLE_CHANGED", "users", `${item.email} → ${item.role} (sesiones invalidadas)`, audit)
  } else if (data.active === false) {
    await logAction(auth, "USER_DISABLED", "users", `${item.email} (sesiones invalidadas)`, audit)
  } else if (data.active === true) {
    await logAction(auth, "USER_ENABLED", "users", item.email, audit)
  } else {
    await logAction(auth, "USER_UPDATED", "users", item.email, audit)
  }
  return NextResponse.json({ item: { id: item.id, email: item.email, name: item.name, role: item.role, active: item.active } })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  if (id === auth.uid) return NextResponse.json({ error: "No puedes eliminar tu propio usuario" }, { status: 400 })
  // LICENSING: eliminar usuarios es premium (users.management)
  const denied = await requireLicenseFeature("users.management")
  if (denied) return denied
  const adminsLeft = await db.user.count({ where: { role: "ADMIN", active: true, NOT: { id } } })
  const target = await db.user.findUnique({ where: { id } })
  if (target?.role === "ADMIN" && adminsLeft === 0) {
    return NextResponse.json({ error: "Debe existir al menos un administrador activo" }, { status: 400 })
  }
  const item = await db.user.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })
  invalidateSessionCache(id) // el usuario ya no existe → sesiones mueren al instante
  await logAction(auth, "USER_DELETED", "users", item.email, { ip: clientIp(_req), resource: "user", resourceId: item.id })
  return NextResponse.json({ ok: true })
}
