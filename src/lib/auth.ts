import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto"
import { getEnv } from "@/lib/env"

// El secreto se obtiene del entorno validado (Zod) — SIN fallback hardcodeado.
// En producción, si falta AUTH_SECRET el servidor no arranca (src/instrumentation.ts).
function authSecret(): string {
  return getEnv().AUTH_SECRET
}

export type Role = "ADMIN" | "OPERATOR" | "VIEWER"

export interface SessionPayload {
  uid: string
  email: string
  name: string
  role: Role
  /** Versión de autenticación del usuario en el momento de la emisión (FASE 2) */
  av: number
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

/** TTL de sesión: 24h (FASE 2 — antes 7 días, demasiado largo para producción). */
export const SESSION_TTL_HOURS = 24

export function signSession(payload: Omit<SessionPayload, "exp">, ttlHours = SESSION_TTL_HOURS): string {
  const data: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlHours * 3600 }
  const body = b64url(JSON.stringify(data))
  const sig = createHmac("sha256", authSecret()).update(body).digest("base64url")
  return `${body}.${sig}`
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = createHmac("sha256", authSecret()).update(body).digest("base64url")
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

// ---------- Validación de sesión contra la DB (FASE 2) ----------

interface DbUserSnapshot {
  id: string
  role: string
  active: boolean
  authVersion: number
}

/**
 * Comprueba que el payload de un token sigue siendo válido contra el usuario
 * real de la DB: mismo uid, usuario activo y authVersion coincide.
 * (Función pura — testeable sin DB.)
 */
export function checkSessionAgainstUser(payload: SessionPayload, user: DbUserSnapshot | null): boolean {
  if (!user) return false // eliminado
  if (user.id !== payload.uid) return false
  if (!user.active) return false // deshabilitado
  if (user.authVersion !== payload.av) return false // password/rol/active cambió
  return true
}

// Cache en memoria de snapshots de usuario (evita golpear SQLite en cada request).
// TTL corto + invalidación explícita al mutar usuarios (mismo proceso).
const USER_CACHE_TTL_MS = 30_000
const userCache = new Map<string, { snap: DbUserSnapshot; exp: number }>()

/** Invalida la cache de un usuario (llamar tras cualquier mutación de User). */
export function invalidateSessionCache(uid?: string): void {
  if (uid) userCache.delete(uid)
  else userCache.clear()
}

async function loadUserSnapshot(uid: string): Promise<DbUserSnapshot | null> {
  const hit = userCache.get(uid)
  if (hit && hit.exp > Date.now()) return hit.snap
  const { db } = await import("@/lib/db")
  const u = await db.user
    .findUnique({ where: { id: uid }, select: { id: true, role: true, active: true, authVersion: true } })
    .catch(() => null)
  if (!u) {
    userCache.delete(uid)
    return null
  }
  userCache.set(uid, { snap: u, exp: Date.now() + USER_CACHE_TTL_MS })
  return u
}

// ---------- Guard helper para API routes ----------
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

/**
 * Sesión COMPLETAMENTE validada (firma + expiración + usuario DB activo +
 * authVersion). El rol devuelto es el FRESCO de la DB (los cambios de rol
 * aplican de inmediato, sin esperar a que caduque el token).
 */
export async function getSessionUser(): Promise<SessionPayload | null> {
  const jar = await cookies()
  const payload = verifySessionToken(jar.get(SESSION_COOKIE)?.value)
  if (!payload) return null
  const snap = await loadUserSnapshot(payload.uid)
  if (!checkSessionAgainstUser(payload, snap)) return null
  // Rol fresco desde DB (fuente de verdad)
  return { ...payload, role: snap!.role as Role }
}

export async function requireAuth(minRole: Role = "VIEWER"): Promise<SessionPayload | NextResponse> {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: "No autenticado o sesión expirada" }, { status: 401 })
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
