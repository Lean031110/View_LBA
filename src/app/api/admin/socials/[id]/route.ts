import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction, notifyContentUpdate } from "@/lib/crud"
import { validateData, socialUpdate } from "@/lib/validators"

const SPEC = {
  network: "s",
  username: "s?",
  url: "s?",
  color: "s?",
  order: "n",
  active: "b",
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const data = pickFields(await readBody(req), SPEC)
  const v = validateData(socialUpdate, data)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const item = await db.socialLink.update({ where: { id }, data: data as never }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Red no encontrada" }, { status: 404 })
  await logAction(auth, "CONTENT_UPDATED", "socials", item.network, { resource: "social", resourceId: id })
  await notifyContentUpdate("socials")
  return NextResponse.json({ item })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const { id } = await params
  const item = await db.socialLink.delete({ where: { id } }).catch(() => null)
  if (!item) return NextResponse.json({ error: "Red no encontrada" }, { status: 404 })
  await logAction(auth, "CONTENT_DELETED", "socials", item.network, { resource: "social", resourceId: id })
  await notifyContentUpdate("socials")
  return NextResponse.json({ ok: true })
}
