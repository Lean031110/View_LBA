/**
 * Rate limiting de login (FASE 3 de la misión).
 *
 * Objetivo: frenar brute-force contra POST /api/auth/login.
 * Diseño compatible con LAN + SQLite (sin Redis):
 *  - Límite por IP (ventana deslizante): N intentos por ventana.
 *  - Límite por CUENTA: M fallos consecutivos → bloqueo temporal con backoff
 *    (15s, 30s, 60s… hasta un máximo). NUNCA permanente: los errores normales
 *    se recuperan solos al expirar el cooldown.
 *  - Estado en memoria del proceso (el login lo atiende un único servidor Next).
 *
 * La respuesta de login NO distingue usuario existente de inexistente (401
 * genérico); el 429 solo indica "demasiados intentos" sin revelar nada más.
 */

export interface RateLimiterOptions {
  /** Ventana por IP (ms) */
  ipWindowMs: number
  /** Máximos intentos por IP dentro de la ventana */
  ipMax: number
  /** Fallos consecutivos por cuenta antes de bloquear */
  accountMaxFails: number
  /** Bloqueo inicial por cuenta (ms) — se duplica en cada bloqueo consecutivo */
  accountBaseBlockMs: number
  /** Tope del bloqueo por cuenta (ms) */
  accountMaxBlockMs: number
}

const DEFAULTS: RateLimiterOptions = {
  ipWindowMs: 5 * 60_000, // 5 min
  ipMax: 12, // 12 intentos / 5 min por IP (login correcto+incorrecto)
  accountMaxFails: 5, // 5 fallos → bloquea la cuenta temporalmente
  accountBaseBlockMs: 30_000, // 30s, 60s, 120s…
  accountMaxBlockMs: 15 * 60_000, // tope 15 min
}

export interface LoginRateResult {
  allowed: boolean
  /** Segundos hasta poder reintentar (solo cuando !allowed) */
  retryAfterSec: number
  /** Motivo interno (para logs, nunca para el cliente) */
  reason?: "ip" | "account"
}

export interface LoginRateLimiter {
  check(ip: string, email: string): LoginRateResult
  recordFailure(ip: string, email: string): void
  recordSuccess(ip: string, email: string): void
}

export function createLoginRateLimiter(opts?: Partial<RateLimiterOptions>): LoginRateLimiter {
  const o = { ...DEFAULTS, ...opts }
  const ipHits = new Map<string, number[]>() // IP → timestamps de intentos
  const accounts = new Map<string, { fails: number; blockedUntil: number; escalations: number }>()

  // Limpieza periódica de entradas muertas (fugas de memoria en 24/7)
  const CLEANUP_MS = 5 * 60_000
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [ip, ts] of ipHits) {
      const alive = ts.filter((t) => now - t < o.ipWindowMs)
      if (alive.length === 0) ipHits.delete(ip)
      else ipHits.set(ip, alive)
    }
    for (const [email, a] of accounts) {
      if (a.blockedUntil < now && a.fails === 0) accounts.delete(email)
    }
  }, CLEANUP_MS)
  cleanup.unref?.()

  function pruneIp(ip: string, now: number): number[] {
    const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < o.ipWindowMs)
    ipHits.set(ip, hits)
    return hits
  }

  return {
    check(ip, email) {
      const now = Date.now()

      // 1) Bloqueo por cuenta (cooldown con backoff)
      const acc = accounts.get(email.toLowerCase())
      if (acc && acc.blockedUntil > now) {
        return { allowed: false, retryAfterSec: Math.ceil((acc.blockedUntil - now) / 1000), reason: "account" }
      }

      // 2) Ventana por IP
      const hits = pruneIp(ip, now)
      if (hits.length >= o.ipMax) {
        const retry = Math.ceil((hits[0] + o.ipWindowMs - now) / 1000)
        return { allowed: false, retryAfterSec: Math.max(retry, 1), reason: "ip" }
      }

      return { allowed: true, retryAfterSec: 0 }
    },

    recordFailure(ip, email) {
      const now = Date.now()
      // registrar intento en la ventana de la IP
      pruneIp(ip, now)
      ipHits.get(ip)!.push(now)

      const key = email.toLowerCase()
      const acc = accounts.get(key) ?? { fails: 0, blockedUntil: 0, escalations: 0 }
      acc.fails += 1
      if (acc.fails >= o.accountMaxFails) {
        // backoff exponencial: base * 2^escalations, acotado
        const blockMs = Math.min(o.accountBaseBlockMs * 2 ** acc.escalations, o.accountMaxBlockMs)
        acc.blockedUntil = now + blockMs
        acc.escalations += 1
        acc.fails = 0 // siguiente ciclo de fallos cuenta de nuevo
      }
      accounts.set(key, acc)
    },

    recordSuccess(ip, email) {
      const key = email.toLowerCase()
      accounts.delete(key) // login correcto → la cuenta queda limpia
      // Los intentos de la IP permanecen (evita alternar éxito/error para
      // eludir el límite de IP)
      void ip
    },
  }
}

/**
 * Instancia única usada por POST /api/auth/login.
 * FASE 30 (misión): límites configurables por entorno (LOGIN_RATE_LIMIT_IP_MAX);
 * p. ej. E2E/CI los sube porque cada test abre sesiones nuevas desde 127.0.0.1.
 * Sin la variable → defaults seguros (12/5min por IP, 5 fallos por cuenta).
 */
export const loginRateLimiter = createLoginRateLimiter({
  ipMax: Number(process.env.LOGIN_RATE_LIMIT_IP_MAX ?? DEFAULTS.ipMax),
})

/**
 * IP del cliente para rate limiting. En LAN directa no hay proxy que fije
 * cabeceras → se agrupa como "direct" (sigue frenando brute force, ya que
 * el atacante y la víctima comparten bucket). Tras Caddy (gateway) usa
 * X-Forwarded-For / X-Real-IP reales.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim()
  return "direct"
}
