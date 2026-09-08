import { NextRequest, NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { logAction } from "@/lib/crud"

/**
 * POST /api/admin/screens/[id]/token — genera (o regenera) el token de
 * emparejamiento de una pantalla (FASE 5/32).
 *
 * - El token en claro se devuelve UNA SOLA VEZ aquí (para copiar al TV).
 * - En la DB solo queda sha256(token) → un robo de DB no permite suplantar.
 * - Regenerar invalida el token anterior de inmediato (el hash cambia).
 * - Solo ADMIN.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth
  const { id } = await params

  const screen = await db.screen.findUnique({ where: { id } })
  if (!screen) return NextResponse.json({ error: "Pantalla no encontrada" }, { status: 404 })

  const token = randomBytes(24).toString("base64url") // 32 chars
  const tokenHash = createHash("sha256").update(token).digest("hex")

  await db.screen.update({ where: { id }, data: { tokenHash } })
  await logAction(auth, "SCREEN_PAIRED", "screens", `${screen.code}: token generado`)

  return NextResponse.json({
    ok: true,
    code: screen.code,
    token, // ÚNICA vez que se muestra
    note: "Cópialo ahora: no volverá a ser visible. Regenerar invalida el anterior.",
  })
}
