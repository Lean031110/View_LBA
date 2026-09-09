import { NextResponse } from "next/server"
import { access, mkdir, constants } from "fs/promises"
import { db } from "@/lib/db"
import { resolveMediaDir, dirSizeBytes, mediaQuotaMB } from "@/lib/media"

export const dynamic = "force-dynamic"

/**
 * GET /api/health — Health REAL de la plataforma (FASE 25).
 *
 * Comprueba (con timeouts cortos, sin secretos en la respuesta):
 *   · database : SELECT 1 con timeout (SQLite viva/accesible)
 *   · storage  : MEDIA_DIR existe/creable + escribible + uso vs cuota
 *   · realtime : mini-servicio :3004/health (socket.io de pantallas/admins)
 *   · stream   : mini-servicio :8100/health (RTMP/HTTP-FLV de OBS/TVs)
 *
 * Semántica de estados:
 *   · ok        (200) — todo operativo
 *   · degraded  (200) — la app SIRVE contenido pero falta algún componente
 *                       (realtime/stream caídos o almacenamiento no escribible):
 *                       las TVs siguen mostrando contenido con polling de respaldo
 *   · unhealthy (503) — base de datos caída: la plataforma no funciona
 *
 * Consumidores: watchdog de la TV (30s), supervisors, CI/deploy (wait-for-ready).
 */
const REALTIME_HEALTH = process.env.REALTIME_HEALTH_URL ?? "http://127.0.0.1:3004/health"
const STREAM_HEALTH = process.env.STREAM_HEALTH_URL ?? "http://127.0.0.1:8100/health"
const PROBE_TIMEOUT_MS = 1500

// Tamaño del directorio de medios CACHEADO (TTL 60s): recorrer cientos de
// archivos en cada poll de cada TV sería costoso; la cifra exacta al minuto
// basta para salud/cuota (la cuota exacta la impone el upload en cada POST).
let mediaUsageCache: { at: number; bytes: number } | null = null
const MEDIA_USAGE_TTL_MS = 60_000

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<null>((res) => {
        timer = setTimeout(() => res(null), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkDatabase(): Promise<boolean> {
  // SQLite bloqueada/colgada → null → false (sin colgar el health)
  const r = await withTimeout(db.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS)
  return r !== null
}

async function checkService(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

interface StorageHealth {
  ok: boolean
  writable: boolean
  usedBytes: number | null
  quotaBytes: number | null
  quotaExceeded: boolean | null
}

async function checkStorage(): Promise<StorageHealth> {
  try {
    const dir = resolveMediaDir()
    await mkdir(dir, { recursive: true })
    await access(dir, constants.W_OK)
    if (!mediaUsageCache || Date.now() - mediaUsageCache.at > MEDIA_USAGE_TTL_MS) {
      mediaUsageCache = { at: Date.now(), bytes: await dirSizeBytes(dir) }
    }
    const quotaBytes = mediaQuotaMB() * 1024 * 1024
    return {
      ok: true,
      writable: true,
      usedBytes: mediaUsageCache.bytes,
      quotaBytes,
      quotaExceeded: mediaUsageCache.bytes >= quotaBytes,
    }
  } catch {
    return { ok: false, writable: false, usedBytes: null, quotaBytes: null, quotaExceeded: null }
  }
}

export async function GET() {
  const [databaseOk, storage, realtimeOk, streamOk] = await Promise.all([
    checkDatabase(),
    checkStorage(),
    checkService(REALTIME_HEALTH),
    checkService(STREAM_HEALTH),
  ])

  const status = !databaseOk ? "unhealthy" : !storage.ok || !realtimeOk || !streamOk ? "degraded" : "ok"
  const httpStatus = status === "unhealthy" ? 503 : 200

  return NextResponse.json(
    {
      status,
      database: { ok: databaseOk },
      storage,
      realtime: { ok: realtimeOk },
      stream: { ok: streamOk },
      ts: Date.now(),
    },
    { status: httpStatus, headers: { "Cache-Control": "no-store" } }
  )
}
