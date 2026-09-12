import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { logAction } from "@/lib/crud"
import { requireLicenseFeature } from "@/lib/licensing/guard"
import { listThemes, importThemePackage, viewlbaVersion, ThemeError } from "@/lib/themes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/admin/themes — inventario de temas (integrados + importados).
 *
 * SIN gating de licencia: durante el trial la sección se VE con el aviso
 * «Los temas de pantalla están disponibles con una licencia completa»
 * (§17 trial: puede visualizar, no importar/aplicar). No expone rutas
 * internas — solo ids de paquete y specs declarativos.
 */
export async function GET() {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  try {
    const themes = await listThemes()
    return NextResponse.json({ themes })
  } catch {
    return NextResponse.json({ error: "Error listando temas" }, { status: 500 })
  }
}

/**
 * POST /api/admin/themes — importar paquete .vtheme (multipart/form-data).
 *
 * LICENSING: importar temas es premium (themes.custom) — trial/limitado
 * recibe 403 con el contacto comercial. El pipeline de validación (21
 * pasos, docs/THEME_SECURITY.md) corre ANTES de escribir nada en disco.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  // §17: trial NO puede importar temas premium
  const denied = await requireLicenseFeature("themes.custom")
  if (denied) return denied

  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Archivo requerido (campo 'file', extensión .vtheme)" }, { status: 400 })
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "El paquete está vacío" }, { status: 400 })
    }

    const buf = Buffer.from(await file.arrayBuffer())
    const result = await importThemePackage(buf, file.name, viewlbaVersion())

    await logAction(auth, "THEME_IMPORTED", "themes", `${result.themeId} v${result.version} (${result.assets} assets)`, {
      resource: "theme",
      resourceId: result.themeId,
      meta: { name: result.name, version: result.version, assets: result.assets, bytes: buf.length },
    })

    return NextResponse.json({ ok: true, theme: result })
  } catch (e) {
    if (e instanceof ThemeError) {
      // Rechazo tipado del pipeline de seguridad — mensaje humano, sin rutas
      await logAction(auth, "THEME_IMPORT_REJECTED", "themes", `${e.code}: ${e.message}`, {
        resource: "theme",
        success: false,
      }).catch(() => {})
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 })
    }
    return NextResponse.json({ error: "Error importando el tema" }, { status: 500 })
  }
}
