import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyPassword, signSession, SESSION_COOKIE, SESSION_TTL_HOURS } from "@/lib/auth"

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: "Email y contraseña requeridos" }, { status: 400 })
    }
    const user = await db.user.findUnique({ where: { email: String(email).toLowerCase().trim() } })
    if (!user || !user.active || !verifyPassword(String(password), user.passwordHash)) {
      await db.log
        .create({
          data: { action: "LOGIN_FAILED", section: "auth", details: `email=${String(email).slice(0, 60)}` },
        })
        .catch(() => {})
      return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 })
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    await db.log
      .create({ data: { userId: user.id, userName: user.name, action: "LOGIN", section: "auth" } })
      .catch(() => {})

    const token = signSession({
      uid: user.id,
      email: user.email,
      name: user.name,
      role: user.role as "ADMIN" | "OPERATOR" | "VIEWER",
      av: user.authVersion,
    })

    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * SESSION_TTL_HOURS, // 24h — alineado con el TTL del token (antes 7 días)
    })
    return res
  } catch {
    return NextResponse.json({ error: "Error del servidor" }, { status: 500 })
  }
}
