import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { activateLicenseToken, CONTACT_PHONE } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

/**
 * POST /api/license/activate — activación de licencia por token (v2).
 * Solo ADMIN. Body JSON: { token: string }.
 *
 * Pipeline de validación TOTAL antes de guardar (formato → trama → firma →
 * esquema → producto → fechas → binding → replay → downgrade). Si algo
 * falla, NO se persiste nada y se audita license_rejected con un motivo
 * HUMANO (sin detalles criptográficos).
 */
const MAX_TOKEN_INPUT = 8192

/** Límite simple en memoria: 10 activaciones por minuto por IP.
 *  Configurable para entornos de test (LICENSE_RATE_LIMIT_MAX) — el default
 *  de producción NO cambia. */
const RATE_LIMIT_MAX = (() => {
  const n = Number(process.env.LICENSE_RATE_LIMIT_MAX ?? 10)
  return Number.isFinite(n) && n > 0 ? n : 10
})()
const RATE_LIMIT_WINDOW_MS = 60_000
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT_MAX
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Demasiados intentos de activación — espera un minuto" }, { status: 429 })
  }

  let token: unknown
  try {
    const body = await req.json()
    token = body?.token
  } catch {
    return NextResponse.json({ error: "Cuerpo JSON inválido — envía { token: \"VLBA2-…\" }" }, { status: 400 })
  }

  if (typeof token !== "string" || token.trim().length === 0) {
    return NextResponse.json({ ok: false, code: "empty_token", reason: "Pega el token de licencia que te envió el proveedor" }, { status: 400 })
  }
  if (token.length > MAX_TOKEN_INPUT) {
    return NextResponse.json({ ok: false, code: "too_long", reason: "El token pegado es demasiado largo — no parece un token ViewLBA" }, { status: 400 })
  }

  try {
    const result = await activateLicenseToken(token, {
      actor: { uid: auth.uid, name: auth.name },
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, code: result.code, reason: result.reason }, { status: 422 })
    }

    const s = result.summary!
    const planLabel = s.plan === "monthly" ? "Mensual" : s.plan === "annual" ? "Anual" : `${s.durationDays} días`
    return NextResponse.json({
      ok: true,
      alreadyActive: result.alreadyActive === true,
      message:
        `${result.alreadyActive ? "Esta licencia ya estaba activa" : "✓ Licencia activada"} — ${s.customerName} · ${planLabel} · vence ${formatDay(s.expiresAt)} (quedan ${s.daysLeft} días)`,
      summary: s,
      contact: CONTACT_PHONE,
    })
  } catch {
    return NextResponse.json({ error: "Error activando la licencia" }, { status: 500 })
  }
}

/** DD/MM/YYYY legible. */
function formatDay(ms: number): string {
  const d = new Date(ms)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${dd}/${mm}/${d.getUTCFullYear()}`
}
