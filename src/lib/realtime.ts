/**
 * Helper server-side para notificar cambios al servicio realtime (puerto 3004).
 * Los cambios de contenido se propagan a las pantallas TV en tiempo real.
 */
import { getEnv } from "@/lib/env"

const INTERNAL_URL = "http://127.0.0.1:3004/broadcast"

function internalToken(): string {
  return getEnv().REALTIME_TOKEN
}

export async function broadcast(
  event: string,
  payload: Record<string, unknown> = {},
  target: "screens" | "admins" | "all" = "screens",
  screenCode?: string
): Promise<void> {
  try {
    await fetch(INTERNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ event, payload, target, screenCode }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // El servicio realtime puede no estar corriendo; las pantallas se recuperan
    // solas vía polling de respaldo (watchdog) — no interrumpimos la operación.
  }
}

/** Notifica a las pantallas que recarguen una sección de contenido */
export function notifyContentUpdate(section: string) {
  return broadcast("content:update", { section, ts: Date.now() }, "screens")
}
