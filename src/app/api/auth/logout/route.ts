import { NextRequest, NextResponse } from "next/server"
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth"
import { logAction } from "@/lib/crud"

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (user) {
    // FASE 26: auditoría estructurada (fallos de auditoría registrados, no silenciosos)
    await logAction({ uid: user.uid, name: user.name }, "LOGOUT", "auth")
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure: req.nextUrl.protocol === "https:" })
  return res
}
