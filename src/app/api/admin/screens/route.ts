import { NextRequest, NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { pickFields, readBody, logAction } from "@/lib/crud"
import { validateData, screenCreate } from "@/lib/validators"
import { broadcast, broadcastToPairingRoom } from "@/lib/realtime"
import type { ScreenStatus } from "@/lib/types"

const SPEC = {
  code: "s",
  name: "s",
  location: "s?",
  notes: "s?",
  active: "b",
}

async function liveStatus(): Promise<ScreenStatus[]> {
  try {
    const res = await fetch("http://127.0.0.1:3004/status", { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return []
    const data = (await res.json()) as { screens?: ScreenStatus[] }
    return data.screens ?? []
  } catch {
    return []
  }
}

/**
 * FASE 6 (misión): estado REAL del servicio realtime — se comprueba el
 * endpoint /health con timeout corto. NUNCA se infiere "online" porque
 * existan pantallas (bug anterior: `screens.length >= 0` siempre true).
 */
async function realtimeOnline(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:3004/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false // caído o timeout → false
  }
}

export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const [screens, live, rtOnline] = await Promise.all([db.screen.findMany({ orderBy: { code: "asc" } }), liveStatus(), realtimeOnline()])
  const liveByCode = new Map(live.map((l) => [l.screenCode, l]))
  const items = screens.map((s) => ({
    ...s,
    online: rtOnline ? (liveByCode.get(s.code)?.online ?? false) : false,
    live: liveByCode.get(s.code) ?? null,
  }))
  return NextResponse.json({ items, realtimeOnline: rtOnline })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = await readBody(req)

  // ---------- FASE 32: flujo de vinculación por código temporal ----------
  // La TV no emparejada muestra un código de 6 dígitos y espera en el room
  // `pair:<código>` del realtime. El admin lo introduce aquí junto al
  // nombre/ubicación → se crea la pantalla CON token y el token viaja al
  // room (solo esa TV lo recibe) → la TV persiste y queda verificada.
  // El código de pantalla (TV-001) se auto-genera si no se proporciona.
  const rawPairCode = typeof body.pairCode === "string" ? body.pairCode.trim() : ""
  if (rawPairCode && !/^\d{6}$/.test(rawPairCode)) {
    return NextResponse.json({ error: "Código de vinculación inválido: 6 dígitos mostrados en la TV", field: "pairCode" }, { status: 400 })
  }
  const pairCode = rawPairCode || null

  const data = pickFields(body, SPEC)
  const name = data.name ? String(data.name) : undefined
  if (!name) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 })

  let code: string | undefined = data.code ? String(data.code) : undefined
  if (!code && !pairCode) {
    return NextResponse.json({ error: "Código y nombre requeridos (o código de vinculación de la TV)" }, { status: 400 })
  }

  // Auto-código TV-### cuando se vincula por código temporal sin código manual
  if (!code) {
    const count = await db.screen.count()
    for (let i = count + 1; i < count + 100; i++) {
      const candidate = `TV-${String(i).padStart(3, "0")}`
      const taken = await db.screen.findUnique({ where: { code: candidate } })
      if (!taken) {
        code = candidate
        break
      }
    }
    if (!code) return NextResponse.json({ error: "No se pudo autogenerar un código de pantalla" }, { status: 500 })
  }

  // Validación COMPLETA (con el código final: manual o autogenerado)
  const v = validateData(screenCreate, { ...data, code, name })
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })

  const exists = await db.screen.findUnique({ where: { code } })
  if (exists) return NextResponse.json({ error: "Ya existe una pantalla con ese código" }, { status: 409 })

  const item = await db.screen.create({
    data: { ...(data as { name: string; location?: string; notes?: string; active?: boolean }), code, name },
  })

  let pairDelivered = 0
  if (pairCode) {
    // Generar token de emparejamiento. ORDEN CRÍTICO: el hash rige en la DB
    // ANTES del broadcast — la TV re-registra en el mismo instante con el
    // token recibido y el realtime valida contra la DB (carrera real de E2E).
    const token = randomBytes(24).toString("base64url")
    const tokenHash = createHash("sha256").update(token).digest("hex")
    await db.screen.update({ where: { id: item.id }, data: { tokenHash } })
    const delivery = await broadcastToPairingRoom(pairCode, "pair:complete", {
      screenCode: code,
      token,
      name,
    })
    pairDelivered = delivery.clients
    await logAction(auth, "SCREEN_PAIRED", "screens", `${code}: vinculada por código ${pairCode} (${pairDelivered ? "token entregado a la TV" : "TV no esperaba"})`, {
      resource: "screen",
      resourceId: item.id,
    })
    if (pairDelivered === 0) {
      // Nadie recibió el token: revertir el hash (estado "sin emparejar" —
      // registro no verificado permitido) para no dejar un hash huérfano.
      await db.screen.update({ where: { id: item.id }, data: { tokenHash: null } })
      return NextResponse.json(
        {
          item,
          paired: false,
          note: "Ninguna TV esperaba ese código. La pantalla quedó creada sin token; pide a la TV que muestre su código y usa 'Vincular' en su tarjeta.",
        },
        { status: 201 }
      )
    }
  } else {
    await logAction(auth, "SCREEN_CREATED", "screens", String(code), { resource: "screen", resourceId: item.id })
  }

  return NextResponse.json({ item, paired: pairCode ? true : undefined, pairDelivered: pairDelivered || undefined }, { status: 201 })
}

/** POST /api/admin/screens/reload — comando remoto a pantallas */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = await readBody(req)
  const command = String(body.command ?? "")
  const screenCode = body.screenCode ? String(body.screenCode) : undefined
  if (!["reload", "fullscreen", "audio"].includes(command)) {
    return NextResponse.json({ error: "Comando no válido" }, { status: 400 })
  }

  // FASE 4: el payload NO viaja tal cual a las pantallas — se valida y
  // reconstruye con esquema estricto por comando (canal cerrado, sin datos
  // arbitrarios desde el admin hacia los navegadores TV).
  let payload: Record<string, unknown> = {}
  if (command === "audio") {
    const p = (body.payload ?? {}) as Record<string, unknown>
    const volume = Number(p.volume)
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return NextResponse.json({ error: "Payload audio inválido: volume 0-100" }, { status: 400 })
    }
    const deviceId = typeof p.deviceId === "string" ? p.deviceId.slice(0, 128) : null
    payload = { volume: Math.round(volume), muted: Boolean(p.muted), deviceId }
  } else if (command === "fullscreen") {
    const p = (body.payload ?? {}) as Record<string, unknown>
    payload = { value: Boolean(p.value) }
  } else {
    payload = {}
  }

  await broadcast("screen:command", { type: command, payload }, "screens", screenCode)
  await logAction(auth, "SCREEN_COMMAND", "screens", `${command}${screenCode ? ` → ${screenCode}` : " → todas"}`, { resource: "screen", resourceId: screenCode ?? "all" })
  return NextResponse.json({ ok: true })
}
