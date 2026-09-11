import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { buildLicenseRequestCode, REQUEST_CODE_MAX_AGE_DAYS, REQUEST_CUSTOMER_NAME_MIN, REQUEST_CUSTOMER_NAME_MAX, CONTACT_PHONE } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/license/request-code — genera el código de solicitud VLREQ2.
 * Solo ADMIN/OPERATOR. Body JSON: { customerName: string }.
 *
 * El código encapsula CIFRADO (X25519 efímero → HKDF → AES-256-GCM) el nombre
 * del negocio + la identidad del equipo (Installation ID + Disk ID, generados
 * automáticamente por el servidor — el cliente JAMÁS los ve ni los copia).
 * Solo la app generadora Android del administrador puede abrirlo.
 *
 * Respuesta: { requestCode: "VLREQ2-…", validForDays, contact }.
 */
const MAX_NAME = 200

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  let customerName: unknown
  try {
    const body = await req.json()
    customerName = body?.customerName
  } catch {
    return NextResponse.json({ error: "Cuerpo JSON inválido — envía { customerName: \"…\" }" }, { status: 400 })
  }

  if (typeof customerName !== "string" || customerName.trim().length === 0) {
    return NextResponse.json(
      { error: `Escribe el nombre de tu negocio (${REQUEST_CUSTOMER_NAME_MIN} a ${REQUEST_CUSTOMER_NAME_MAX} caracteres)` },
      { status: 400 }
    )
  }
  if (customerName.length > MAX_NAME) {
    return NextResponse.json({ error: "El nombre del negocio es demasiado largo" }, { status: 400 })
  }

  try {
    const requestCode = await buildLicenseRequestCode({ customerName })
    return NextResponse.json(
      {
        requestCode,
        validForDays: REQUEST_CODE_MAX_AGE_DAYS,
        contact: CONTACT_PHONE,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    const msg = (e as Error).message ?? ""
    if (msg.includes("nombre")) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ error: "No se pudo generar el código de solicitud" }, { status: 500 })
  }
}
