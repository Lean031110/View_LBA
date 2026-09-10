import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { importLicenseZip } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

/**
 * POST /api/license/import — importación de la licencia ZIP (sección 15).
 * Solo ADMIN. Multipart/form-data con campo "file" (.zip).
 *
 * Validación TOTAL antes de guardar (firma → esquema → producto → fechas →
 * Installation ID → Disk ID → features). Si algo falla, NO se persiste nada
 * y se audita license_rejected.
 */
const MAX_ZIP_BYTES = 1024 * 1024 // 1 MB: un ZIP de licencia son unos KB

export async function POST(req: NextRequest) {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth

  let buffer: Buffer
  let filename = ""
  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Adjunta el archivo ZIP de la licencia (campo file)" }, { status: 400 })
    }
    if (file.size > MAX_ZIP_BYTES) {
      return NextResponse.json({ error: "El archivo ZIP excede 1 MB — no parece una licencia ViewLBA" }, { status: 400 })
    }
    filename = file.name
    if (!filename.toLowerCase().endsWith(".zip")) {
      return NextResponse.json({ error: "La licencia debe venir en un archivo .zip" }, { status: 400 })
    }
    buffer = Buffer.from(await file.arrayBuffer())
  } catch {
    return NextResponse.json({ error: "No se pudo leer el archivo subido" }, { status: 400 })
  }

  try {
    const result = await importLicenseZip(buffer, {
      actor: { uid: auth.uid, name: auth.name },
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, reasons: result.reasons }, { status: 422 })
    }

    return NextResponse.json({
      ok: true,
      message: `✓ Licencia válida — ${result.summary?.customerName} · plan ${result.summary?.plan === "monthly" ? "Mensual" : "Anual"} · vence ${result.summary?.expiresAt.slice(0, 10)} (${result.summary?.daysLeft} días)`,
      summary: result.summary,
    })
  } catch (e) {
    return NextResponse.json({ error: `Error importando la licencia: ${(e as Error).message}` }, { status: 500 })
  }
}
