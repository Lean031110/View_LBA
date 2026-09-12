import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { logAction } from "@/lib/crud"
import { requireLicenseFeature } from "@/lib/licensing/guard"
import { deleteTheme, activateTheme, ThemeError } from "@/lib/themes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * DELETE /api/admin/themes/[id] — eliminar un tema IMPORTADO.
 *
 * · Temas integrados (Default/Classic/Neon) → 403 builtin_protected (§7:
 *   no se puede eliminar el predeterminado).
 * · Si el tema eliminado era el ACTIVO → se vuelve a Default (§14).
 * · §17: si la licencia completa VENCE, los temas NO se borran — solo se
 *   bloquea la gestión (aquí, con el 403 de themes.custom).
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  const denied = await requireLicenseFeature("themes.custom")
  if (denied) return denied

  const { id } = await params
  try {
    const result = await deleteTheme(id)
    await logAction(auth, "THEME_DELETED", "themes", `${result.deletedThemeId}${result.revertedToDefault ? " (activo → Default)" : ""}`, {
      resource: "theme",
      resourceId: result.deletedThemeId,
      meta: { revertedToDefault: result.revertedToDefault },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof ThemeError) {
      const status = e.code === "not_found" ? 404 : e.code === "builtin_protected" ? 403 : 400
      return NextResponse.json({ error: e.message, code: e.code }, { status })
    }
    return NextResponse.json({ error: "Error eliminando el tema" }, { status: 500 })
  }
}

/**
 * POST /api/admin/themes/[id] — activar el tema (action=activate).
 * El body es opcional: POST sin body también activa (ergonomía de UI).
 *
 * La activación re-valida el spec del tema desde disco (paso 20 en cada
 * uso) y emite broadcast realtime → las TVs refrescan al instante (§15).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  const denied = await requireLicenseFeature("themes.custom")
  if (denied) return denied

  const { id } = await params

  // Body opcional { action?: "activate" } — solo se acepta "activate"
  let action = "activate"
  try {
    const body = (await req.json()) as { action?: unknown }
    if (body && typeof body === "object" && "action" in body) {
      if (body.action !== "activate") {
        return NextResponse.json({ error: `Acción no soportada: ${String(body.action)}` }, { status: 400 })
      }
      action = "activate"
    }
  } catch {
    // sin body / no JSON → activate por defecto
  }

  try {
    const result = await activateTheme(id)
    await logAction(auth, "THEME_ACTIVATED", "themes", `${result.themeId}${result.revertedToDefault ? " (Default)" : ""}`, {
      resource: "theme",
      resourceId: result.themeId,
      meta: { name: result.name, action },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof ThemeError) {
      const status = e.code === "not_found" ? 404 : 400
      return NextResponse.json({ error: e.message, code: e.code }, { status })
    }
    return NextResponse.json({ error: "Error activando el tema" }, { status: 500 })
  }
}
