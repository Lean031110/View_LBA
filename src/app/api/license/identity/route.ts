import { NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { getInstallationIdentity } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/license/identity — identificación del equipo para solicitar
 * la licencia (sección 2/34). Solo ADMIN/OPERATOR.
 *
 * Devuelve el INSTALLATION_ID público, el Disk ID y la ruta — lo que el
 * cliente debe enviar al proveedor. NUNCA expone hashes completos ni
 * seriales físicos crudos (sección 32: UX sin jeroglíficos).
 */
export async function GET() {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  try {
    const identity = await getInstallationIdentity()
    return NextResponse.json(
      {
        installationId: identity.installationId,
        diskId: identity.diskId,
        diskLabel: identity.diskLabel,
        installPath: identity.installPath,
        // Bloque listo para copiar/pegar al proveedor (sección 34)
        requestBlock: [
          "ViewLBA — Solicitud de licencia",
          `Installation ID: ${identity.installationId}`,
          `Disk ID: ${identity.diskId}`,
          `Ruta: ${identity.installPath}`,
        ].join("\n"),
        bindingStrength: {
          fingerprint: identity.fingerprintMethod,
          disk: identity.diskBindingMethod,
        },
        contact: "52973387",
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json({ error: "No se pudo identificar la instalación" }, { status: 500 })
  }
}
