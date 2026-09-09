import { NextRequest, NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { readBody, logAction } from "@/lib/crud"
import { broadcastToPairingRoom } from "@/lib/realtime"

/**
 * POST /api/admin/screens/[id]/token — genera (o regenera) el token de
 * emparejamiento de una pantalla (FASE 5/32).
 *
 * Dos modos:
 *  1. CON body {pairCode} (recomendado — FASE 32): la TV muestra un código
 *     de 6 dígitos y espera en el room `pair:<código>`. El token nuevo se
 *     entrega ahí directamente (nunca vuelve al admin). Si NADIE espera ese
 *     código → 400 sin generar (un hash huérfano dejaría la pantalla
 *     bloqueada para registros no verificados).
 *  2. SIN pairCode (legacy): el token en claro se devuelve UNA SOLA VEZ
 *     (para automatización/API; la UI de la TV solo acepta tokens vía
 *     pair:complete). Regenerar invalida el anterior de inmediato.
 *
 * - En la DB solo queda sha256(token) → un robo de DB no permite suplantar.
 * - Solo ADMIN.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params

  const screen = await db.screen.findUnique({ where: { id } })
  if (!screen) return NextResponse.json({ error: "Pantalla no encontrada" }, { status: 404 })

  const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>
  const pairCode = typeof body?.pairCode === "string" ? body.pairCode.trim() : ""
  if (pairCode && !/^\d{6}$/.test(pairCode)) {
    return NextResponse.json({ error: "Código de vinculación inválido: 6 dígitos mostrados en la TV" }, { status: 400 })
  }

  const token = randomBytes(24).toString("base64url") // 32 chars
  const tokenHash = createHash("sha256").update(token).digest("hex")

  if (pairCode) {
    // ORDEN CRÍTICO (carrera real encontrada en E2E): el hash nuevo debe
    // regir EN LA DB ANTES de difundir el token — la TV lo usa para
    // re-registrarse en el mismo instante y el realtime valida contra la DB.
    // Si el hash viejo siguiera vigente → bad-token → la TV descartaría su
    // token recién recibido.
    await db.screen.update({ where: { id }, data: { tokenHash } })

    const delivery = await broadcastToPairingRoom(pairCode, "pair:complete", {
      screenCode: screen.code,
      token,
      name: screen.name,
    })
    if (delivery.clients === 0) {
      // Nadie recibió el token: revertir al estado "sin emparejar" (hash nulo)
      // para no dejar un hash huérfano que bloquearía registros de esa TV.
      await db.screen.update({ where: { id }, data: { tokenHash: null } })
      return NextResponse.json(
        { error: "Ninguna TV espera ese código. Pide al televisor que muestre su código de vinculación (tecla S) y reintenta." },
        { status: 400 }
      )
    }
    await logAction(auth, "SCREEN_PAIRED", "screens", `${screen.code}: token regenerado y entregado por código ${pairCode}`, {
      resource: "screen",
      resourceId: id,
    })
    return NextResponse.json({
      ok: true,
      code: screen.code,
      delivered: true,
      note: "Token nuevo entregado a la TV en espera. El token anterior quedó invalidado.",
    })
  }

  await db.screen.update({ where: { id }, data: { tokenHash } })
  await logAction(auth, "SCREEN_PAIRED", "screens", `${screen.code}: token generado`, { resource: "screen", resourceId: id })

  return NextResponse.json({
    ok: true,
    code: screen.code,
    token, // ÚNICA vez que se muestra (modo legacy/automatización)
    note: "Cópialo ahora: no volverá a ser visible. Regenerar invalida el anterior.",
  })
}
