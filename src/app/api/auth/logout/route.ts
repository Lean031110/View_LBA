import { NextResponse } from "next/server"
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth"
import { logAction } from "@/lib/crud"

export async function POST() {
  const user = await getSessionUser()
  if (user) {
    // FASE 26: auditoría estructurada (fallos de auditoría registrados, no silenciosos)
    await logAction({ uid: user.uid, name: user.name }, "LOGOUT", "auth")
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
  return res
}
