import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto"

const SECRET = process.env.AUTH_SECRET || "signage-dev-secret-change-me"

export type Role = "ADMIN" | "OPERATOR" | "VIEWER"

export interface SessionPayload {
  uid: string
  email: string
  name: string
  role: Role
  exp: number // epoch seconds
}

// ---------- Password hashing (scrypt) ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// ---------- Session token (HMAC-SHA256) ----------
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

export function signSession(payload: Omit<SessionPayload, "exp">, ttlHours = 24 * 7): string {
  const data: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlHours * 3600 }
  const body = b64url(JSON.stringify(data))
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url")
  return `${body}.${sig}`
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export const SESSION_COOKIE = "signage_session"

// ---------- Guard helper para API routes ----------
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export async function getSessionUser(): Promise<SessionPayload | null> {
  const jar = await cookies()
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value)
}

export async function requireAuth(minRole: Role = "VIEWER"): Promise<SessionPayload | NextResponse> {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 })
  }
  const rank: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 }
  if (rank[user.role] < rank[minRole]) {
    return NextResponse.json({ error: "Permisos insuficientes" }, { status: 403 })
  }
  return user
}

export function isNextResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse
}
