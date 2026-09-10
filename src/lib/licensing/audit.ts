/**
 * ViewLBA — Auditoría de eventos de licenciamiento (sección 22).
 *
 * Vocabulario EXACTO del requisito:
 *   license_imported · license_rejected · license_expired · license_mismatch
 *   trial_started · trial_expired · clock_tampering_detected
 *
 * Usa la MISMA infraestructura de auditoría del proyecto (logAction →
 * tabla Log + logger JSON stdout/archivo). JAMÁS registra secretos
 * (logAction aplica redact() + truncado).
 */
import type { LicenseAuditEvent } from "./types"

export interface LicenseAuditOptions {
  /** Actor (usuario admin) si la acción partió de una persona. */
  actor?: { uid: string; name: string } | null
  /** Metadatos seguros (sin secretos). */
  meta?: Record<string, unknown>
  /** Detalle corto legible. */
  details?: string
}

/** Registra un evento de licenciamiento (best-effort, nunca lanza). */
export async function logLicenseEvent(event: LicenseAuditEvent, opts: LicenseAuditOptions = {}): Promise<void> {
  try {
    const { logAction } = await import("@/lib/crud")
    await logAction(opts.actor ?? null, event, "license", opts.details, {
      resource: "license",
      meta: opts.meta,
    })
  } catch {
    // la auditoría no puede romper la operación de licencia
  }
}
