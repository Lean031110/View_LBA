/**
 * Health final de la instalación — REUTILIZA /api/health del servidor.
 *
 * La misión exige validar: application, database, storage, realtime, stream
 * — y NO declarar "instalación correcta" si health falla.
 */
import type { CheckResult, HealthArea, HealthReport } from "./types"

export interface HealthEndpoints {
  app: string
  realtime: string
  stream: string
}

export const DEFAULT_HEALTH_ENDPOINTS: HealthEndpoints = {
  app: "http://127.0.0.1:3000/api/health",
  realtime: "http://127.0.0.1:3004/health",
  stream: "http://127.0.0.1:8100/health",
}

export interface PollOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Callback de progreso (para la UI). */
  onTick?: (attempt: number, elapsedMs: number) => void
  fetchFn?: typeof fetch
}

/** Forma de /api/health (ver src/app/api/health/route.ts). */
interface AppHealthJson {
  status: "ok" | "degraded" | "unhealthy"
  database: { ok: boolean }
  storage: { ok: boolean; writable?: boolean }
  realtime: { ok: boolean }
  stream: { ok: boolean }
}

/**
 * Espera a que /api/health responda (hasta timeout) y valida las 5 áreas.
 * `unreachable` = ni siquiera respondió (app caída).
 */
export async function waitForHealth(
  endpoints: HealthEndpoints,
  opts: PollOptions = {}
): Promise<HealthReport> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 2000
  const doFetch = opts.fetchFn ?? fetch
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let lastError = "sin respuesta"

  for (;;) {
    attempt++
    try {
      const res = await doFetch(endpoints.app, { signal: AbortSignal.timeout(2500) })
      if (res.ok || res.status === 503) {
        const body = (await res.json()) as AppHealthJson
        const areas: HealthArea[] = [
          { key: "application", ok: true, detail: `HTTP ${res.status}` },
          { key: "database", ok: Boolean(body.database?.ok) },
          { key: "storage", ok: Boolean(body.storage?.ok) },
          { key: "realtime", ok: Boolean(body.realtime?.ok) },
          { key: "stream", ok: Boolean(body.stream?.ok) },
        ]
        const ok = body.status === "ok"
        return { ok, status: body.status, httpStatus: res.status, areas }
      }
      lastError = `HTTP ${res.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (Date.now() >= deadline) break
    opts.onTick?.(attempt, Date.now() - (deadline - timeoutMs))
    await sleep(Math.min(intervalMs, deadline - Date.now()))
  }

  return {
    ok: false,
    status: "unreachable",
    areas: [{ key: "application", ok: false, detail: lastError }],
  }
}

/** Mini-servicios directamente (sin pasar por la app) — para diagnóstico. */
export async function probeService(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

/** Convierte un HealthReport en checks (para el reporte/UI). */
export function healthChecks(report: HealthReport): CheckResult[] {
  const labels: Record<HealthArea["key"], string> = {
    application: "Application (app Next.js)",
    database: "Database (SQLite + Prisma)",
    storage: "Storage (media, cuota y permisos)",
    realtime: "Realtime (socket.io :3003/:3004)",
    stream: "Stream (RTMP/FLV :1935/:8000/:8100)",
  }
  const out: CheckResult[] = []
  const seen = new Set<HealthArea["key"]>()
  for (const area of report.areas) {
    seen.add(area.key)
    out.push({
      id: `health-${area.key}`,
      label: labels[area.key],
      status: area.ok ? "pass" : report.status === "degraded" ? "warn" : "fail",
      detail: area.detail,
      hint: area.ok ? undefined : hintFor(area.key),
    })
  }
  if (!seen.has("application")) {
    out.push({
      id: "health-application",
      label: labels.application,
      status: "fail",
      detail: report.areas[0]?.detail ?? "sin respuesta",
      hint: hintFor("application"),
    })
  }
  return out
}

function hintFor(key: HealthArea["key"]): string {
  switch (key) {
    case "application":
      return "Revisa el log del servicio app (journalctl -u pantalla-restaurante / logs\\PantallaRestaurante.err.log)"
    case "database":
      return "Revisa permisos del directorio de datos y la DATABASE_URL del .env"
    case "storage":
      return "Revisa permisos de MEDIA_DIR y el espacio en disco"
    case "realtime":
      return "Revisa el servicio realtime (journalctl -u pantalla-restaurante-realtime)"
    case "stream":
      return "Revisa el servicio stream y que los puertos 1935/8000 estén libres"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
