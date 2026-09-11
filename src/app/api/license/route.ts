import { NextRequest, NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { getLicenseSystemState, getLicenseHistory, licenseStateEpoch, CONTACT_PHONE } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/license — estado del sistema de licencias (v2, copiar/pegar).
 *
 * PÚBLICO (TV / watchdog): resumen SIN datos de cliente ni identificadores
 * de binding — solo lo necesario para pintar watermark y features.
 * ADMIN (cookie de sesión): respuesta enriquecida con el resumen seguro de
 * la licencia (cliente, plan, fechas, días) e historial — SIN Installation
 * ID, Disk ID, hashes ni ningún dato técnico: la identidad vive oculta en el
 * servidor y viaja encapsulada dentro del código de solicitud VLREQ2.
 *
 * Cache interno de 3s: la evaluación implica detección de hardware/disco
 * (child_process) — no debe ejecutarse por cada poll de cada TV.
 */
const CACHE_TTL_MS = 3000
let cache: { at: number; epoch: number; body: Record<string, unknown> } | null = null

export async function GET(_req: NextRequest) {
  try {
    const user = await getSessionUser().catch(() => null)
    const isAdmin = user?.role === "ADMIN" || user?.role === "OPERATOR"

    // El cuerpo PÚBLICO se cachea 3s, PERO se invalida al instante cuando
    // cambia la época de estado (activación de licencia).
    const epoch = licenseStateEpoch()
    let publicBody: Record<string, unknown>
    if (cache && cache.epoch === epoch && Date.now() - cache.at < CACHE_TTL_MS) {
      publicBody = cache.body
    } else {
      const state = await getLicenseSystemState()
      publicBody = {
        product: "ViewLBA-Server",
        status: state.status,
        plan: state.license?.plan ?? (state.status === "trial" ? "trial" : null),
        daysLeft: state.daysLeft,
        clockTampered: state.clockTampered,
        watermark: {
          visible: state.features.watermark,
          lines: state.features.watermarkLines,
        },
        features: state.features.flags,
        ts: Date.now(),
      }
      cache = { at: Date.now(), epoch, body: publicBody }
    }

    if (!isAdmin) {
      return NextResponse.json(publicBody, { headers: { "Cache-Control": "no-store" } })
    }

    // ---- Vista ADMIN (operador+) — resumen seguro, sin datos técnicos ----
    const state = await getLicenseSystemState()
    const history = await getLicenseHistory()

    return NextResponse.json(
      {
        ...publicBody,
        reasons: state.reasons,
        trial: state.trial
          ? {
              active: state.trial.active,
              daysLeft: state.trial.daysLeft,
              startedAt: state.trial.startedAt ? new Date(state.trial.startedAt).toISOString() : null,
              endsAt: state.trial.endsAt ? new Date(state.trial.endsAt).toISOString() : null,
            }
          : null,
        license: state.license
          ? {
              licenseId: state.license.licenseId,
              customerName: state.license.customerName,
              plan: state.license.plan,
              durationDays: state.license.durationDays,
              issuedAt: state.license.issuedAt,
              startsAt: state.license.startsAt,
              expiresAt: state.license.expiresAt,
              daysLeft: state.daysLeft,
            }
          : null,
        history: history.slice(0, 20).map((h) => ({
          licenseId: h.licenseId,
          customerName: h.customerName,
          plan: h.plan,
          durationDays: h.durationDays,
          startsAt: h.startsAt,
          expiresAt: h.expiresAt,
          activatedAt: h.activatedAt,
          current: h.current,
        })),
        contact: CONTACT_PHONE,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json({ error: "Error evaluando el estado de licencia" }, { status: 500 })
  }
}
