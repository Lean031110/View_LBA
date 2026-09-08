/**
 * Autenticación del realtime-service (FASE 5).
 * Funciones PURAS (testeables sin levantar el servidor socket.io):
 *  - verificación de la cookie de sesión (mismo HMAC que src/lib/auth.ts)
 *  - hash de tokens de pantalla (sha256)
 *  - política CORS de orígenes permitidos (LAN-first, sin "*")
 *  - saneo de payloads stream:server para audiencia de pantallas
 */
import { createHash, createHmac, timingSafeEqual } from "crypto"

// ---------- Cookie de sesión admin (HMAC-SHA256, igual que la app) ----------

export interface AdminIdentity {
  uid: string
  email: string
  name: string
  role: "ADMIN" | "OPERATOR" | "VIEWER"
}

export interface SessionPayloadShape {
  uid: string
  email: string
  name: string
  role: string
  av?: number
  exp: number
}

/** Extrae el valor de una cookie de la cabecera Cookie del handshake. */
export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=")
  }
  return null
}

/** Verifica firma + expiración del token de sesión (sin DB). */
export function verifySessionToken(token: string, authSecret: string): SessionPayloadShape | null {
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = createHmac("sha256", authSecret).update(body).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayloadShape
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export interface DbUserRow {
  id: string
  role: string
  active: number
  authVersion: number
}

/** Valida el payload contra el usuario real de la DB (activo + authVersion). */
export function checkAdminSession(
  payload: SessionPayloadShape | null,
  user: DbUserRow | null
): AdminIdentity | null {
  if (!payload || !user) return null
  if (user.id !== payload.uid) return null
  if (!user.active) return null
  if (user.authVersion !== (payload.av ?? -1)) return null // token viejo/foreign
  const role = user.role
  if (role !== "ADMIN" && role !== "OPERATOR" && role !== "VIEWER") return null
  return { uid: user.id, email: payload.email, name: payload.name, role }
}

// ---------- Tokens de pantalla (pairing) ----------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export interface ScreenAuthRow {
  code: string
  active: number
  tokenHash: string | null
}

export type ScreenAuthResult =
  | { ok: true; verified: boolean } // verified: token válido (o pantalla sin pairing aún)
  | { ok: false; reason: "unknown" | "inactive" | "bad-token" }

/**
 * Valida el registro de una pantalla:
 *  - code desconocido → rechazada (nadie se registra con un código inventado)
 *  - pantalla inactiva → rechazada
 *  - tokenHash configurado → el token debe coincidir (sha256); si no → rechazo
 *    (impide suplantar una pantalla emparejada)
 *  - sin tokenHash (aún sin emparejar) → aceptada como NO verificada
 *    (transición hasta completar el pairing — FASE 32)
 */
export function checkScreenAuth(
  screenCode: string,
  token: string | undefined,
  screen: ScreenAuthRow | null
): ScreenAuthResult {
  if (!screen || screen.code !== screenCode) return { ok: false, reason: "unknown" }
  if (!screen.active) return { ok: false, reason: "inactive" }
  if (screen.tokenHash) {
    if (!token) return { ok: false, reason: "bad-token" }
    if (sha256Hex(token) !== screen.tokenHash) return { ok: false, reason: "bad-token" }
    return { ok: true, verified: true }
  }
  return { ok: true, verified: false }
}

// ---------- CORS de orígenes permitidos (sin "*") ----------

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|host\.docker\.internal)$/i

/**
 * ¿Origen permitido para conectar al websocket?
 * Reglas (LAN-first, sin romper la LAN):
 *  1. Orígenes explícitos de ALLOWED_ORIGINS (env, separados por coma).
 *  2. Orígenes cuyo host coincide con el Host del handshake (la propia app
 *     servida desde este equipo: http://IP:3000, :81, :443…).
 *  3. Orígenes de hosts privados (LAN/localhost) — el navegador del personal.
 * NUNCA "*" — un sitio público de Internet no puede conectarse al socket de
 * la LAN del restaurante desde el navegador de una víctima (CSWSH).
 */
export function originAllowed(
  origin: string | undefined,
  handshakeHost: string | undefined,
  extraAllowed: string[] = []
): boolean {
  if (!origin) return true // clientes no-navegador (p.ej. tests) sin Origin
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  if (extraAllowed.includes(origin)) return true
  const hsHost = (handshakeHost ?? "").split(":")[0]
  if (hsHost && host === hsHost) return true
  if (PRIVATE_HOST.test(host)) return true
  return false
}

// ---------- Saneo de eventos para pantallas (no filtrar info a TVs) ----------

const SCREEN_SENSITIVE_FIELDS = ["publisherIp", "lastSession"] as const

/** Elimina campos sensibles del payload cuando el destinatario es una pantalla. */
export function sanitizeForScreens(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload
  const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  for (const f of SCREEN_SENSITIVE_FIELDS) delete clone[f]
  return clone
}
