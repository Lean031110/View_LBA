import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyPassword, signSession, SESSION_COOKIE, SESSION_TTL_HOURS } from "@/lib/auth"
import { loginRateLimiter, clientIp } from "@/lib/rate-limit"

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: "Email y contraseña requeridos" }, { status: 400 })
    }
    const normalizedEmail = String(email).toLowerCase().trim()
    const ip = clientIp(req)

    // FASE 3: rate limiting ANTES de tocar la DB (brute force)
    const rl = loginRateLimiter.check(ip, normalizedEmail)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Demasiados intentos. Espera antes de reintentar." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      )
    }

    const user = await db.user.findUnique({ where: { email: normalizedEmail } })
    if (!user || !user.active || !verifyPassword(String(password), user.passwordHash)) {
      loginRateLimiter.recordFailure(ip, normalizedEmail)
      await db.log
        .create({
          data: {
            action: "LOGIN_FAILED",
            section: "auth",
            details: `email=${normalizedEmail.slice(0, 60)} ip=${ip}`,
          },
        })
        .catch(() => {})
      // 401 genérico idéntico para usuario inexistente / password errónea / inactivo
      // (no revela cuál es la causa)
      return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 })
    }

    loginRateLimiter.recordSuccess(ip, normalizedEmail)
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    await db.log
      .create({ data: { userId: user.id, userName: user.name, action: "LOGIN", section: "auth", details: `ip=${ip}` } })
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
