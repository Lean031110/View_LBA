import { NextResponse } from "next/server"
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"

export async function POST() {
  const user = await getSessionUser()
  if (user) {
    await db.log
      .create({ data: { userId: user.uid, userName: user.name, action: "LOGOUT", section: "auth" } })
      .catch(() => {})
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 })
  return res
}
