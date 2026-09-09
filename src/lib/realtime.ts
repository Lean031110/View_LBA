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

/**
 * FASE 32: emite un evento SOLO al room de pairing `pair:<pairCode>` (la TV
 * no emparejada que mostró ese código en pantalla está esperando ahí).
 * Devuelve el número de clientes del room → 0 = nadie esperaba ese código.
 * El servicio valida el prefijo pair: — no se pueden apuntar rooms arbitrarias.
 */
async function emitToPairingRoomOnce(
  pairCode: string,
  event: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; clients: number }> {
  try {
    const res = await fetch(INTERNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ event, payload, room: `pair:${pairCode}` }),
      signal: AbortSignal.timeout(3000),
    })
    const data = (await res.json().catch(() => ({}))) as { clients?: number }
    return { ok: res.ok, clients: data.clients ?? 0 }
  } catch {
    return { ok: false, clients: 0 }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function broadcastToPairingRoom(
  pairCode: string,
  event: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; clients: number }> {
  if (!/^\d{6}$/.test(pairCode)) return { ok: false, clients: 0 }
  // Carrera documentada: la TV muestra el código ANTES de que su socket
  // (fallback ws→polling en LAN) se una al room. Un reintento corto cubre la
  // unión tardía; el re-join periódico de la TV cubre reemplazos de sesión.
  let r = await emitToPairingRoomOnce(pairCode, event, payload)
  if (r.clients === 0) {
    await sleep(600)
    r = await emitToPairingRoomOnce(pairCode, event, payload)
  }
  return r
}
