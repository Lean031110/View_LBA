import { db } from "@/lib/db"
import { notifyContentUpdate } from "@/lib/realtime"
import { logEvent, redact } from "@/lib/logger"

export { pickFields, readBody } from "@/lib/fields"

/** Actor mínimo para auditoría (SessionPayload es estructuralmente compatible). */
export type AuditActor = { uid: string; name: string } | null

export interface AuditOptions {
  /** IP del actor (login/acciones admin) */
  ip?: string | null
  /** Entidad afectada: "user" | "screen" | "promotion" | "settings" | ... */
  resource?: string
  /** Id de la entidad afectada */
  resourceId?: string
  /** ¿La operación tuvo éxito? (default true) */
  success?: boolean
  /** Metadatos seguros (redact() los limpia antes de persistir) */
  meta?: Record<string, unknown>
}

/**
 * Auditoría (FASE 26+27): UNA sola llamada escribe:
 *   1. Fila en la tabla Log (ip/resource/resourceId/success/metadata)
 *   2. Evento JSON estructurado a stdout + archivo rotativo (logger)
 *
 * JAMÁS lanza (la auditoría no puede romper la petición), pero los FALLOS
 * de la propia auditoría se registran de verdad (nada de catch silencioso).
 */
export async function logAction(user: AuditActor, action: string, section: string, details?: string, opts: AuditOptions = {}) {
  // 1) evento estructurado (stdout + archivo) — sanitizado
  logEvent({
    event: action,
    actor: user ? { uid: user.uid, name: user.name } : null,
    ip: opts.ip ?? undefined,
    resource: opts.resource ?? section,
    resourceId: opts.resourceId,
    success: opts.success ?? true,
    meta: { ...(opts.meta ?? {}), ...(details ? { details: details.slice(0, 500) } : {}), section },
  })

  // 2) fila de auditoría en DB (best-effort, con error REGISTRADO)
  try {
    await db.log.create({
      data: {
        userId: user?.uid ?? null,
        userName: user?.name ?? null,
        action,
        section,
        details: details?.slice(0, 500),
        ip: opts.ip?.slice(0, 64) ?? null,
        resource: opts.resource ?? null,
        resourceId: opts.resourceId?.slice(0, 128) ?? null,
        success: opts.success ?? true,
        metadata: opts.meta ? JSON.stringify(redact(opts.meta)).slice(0, 2000) : null,
      },
    })
  } catch (e) {
    // La auditoría falló (DB caída/locked): se DEJA CONSTANCIA en el logger
    logEvent({
      event: "AUDIT_WRITE_FAILED",
      level: "error",
      success: false,
      actor: user ? { uid: user.uid, name: user.name } : null,
      meta: { action, section, error: e instanceof Error ? e.message : String(e) },
    })
  }
}

export { notifyContentUpdate }
