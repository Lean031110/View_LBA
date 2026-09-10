import { NextRequest, NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { getLicenseSystemState, getInstallationIdentity, getLicenseHistory, licenseStateEpoch } from "@/lib/licensing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/license — estado del sistema de licencias (sección 21).
 *
 * PÚBLICO (TV / watchdog): resumen SIN datos de cliente ni identificadores
 * de binding — solo lo necesario para pintar watermark y features.
 * ADMIN (cookie de sesión): respuesta enriquecida con datos de la licencia,
 * Installation ID, Disk ID y motivos de estado.
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
    // cambia la época de estado (importación de licencia).
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

    // ---- Vista ADMIN (operador+) ----
    const state = await getLicenseSystemState()
    const identity = await getInstallationIdentity()
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
        license: state.license,
        validation: state.validation
          ? {
              status: state.validation.status,
              reasons: state.validation.reasons,
              detail: state.validation.detail,
            }
          : null,
        identity: {
          installationId: identity.installationId,
          diskId: identity.diskId,
          diskLabel: identity.diskLabel,
          installPath: identity.installPath,
          bindingStrength: {
            fingerprint: identity.fingerprintMethod,
            disk: identity.diskBindingMethod,
          },
        },
        history: history.slice(0, 20),
        contact: "52973387",
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    return NextResponse.json({ error: "Error evaluando el estado de licencia" }, { status: 500 })
  }
}
