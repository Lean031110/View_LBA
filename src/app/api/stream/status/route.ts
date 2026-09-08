import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

/**
 * GET /api/stream/status — Estado PÚBLICO del servidor de transmisión.
 * Lo consulta la pantalla TV (polling de respaldo al realtime) para saber
 * si hay un publicador (OBS) conectado antes de abrir el reproductor.
 * Nunca expone la clave de transmisión.
 */
interface StreamServiceStatus {
  ok: boolean
  live: boolean
  since: number | null
  viewers: number
  publisherIp: string | null
  hasKey: boolean
  uptimeSec: number
}

async function fetchStreamService(): Promise<StreamServiceStatus | null> {
  try {
    const res = await fetch("http://127.0.0.1:8100/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    return (await res.json()) as StreamServiceStatus
  } catch {
    return null
  }
}

export async function GET() {
  const settings = await db.settings.findUnique({
    where: { id: "main" },
    select: { streamSource: true, streamEnabled: true },
  })
  const source = settings?.streamSource ?? "external"

  if (source !== "local") {
    // Modo externo: el estado real lo determina el reproductor de cada TV
    return NextResponse.json(
      { source, streamEnabled: settings?.streamEnabled ?? true, serverOk: true, live: null, ts: Date.now() },
      { headers: { "Cache-Control": "no-store" } }
    )
  }

  const svc = await fetchStreamService()
  return NextResponse.json(
    {
      source,
      streamEnabled: settings?.streamEnabled ?? true,
      serverOk: Boolean(svc), // ¿el mini-servicio de streaming está corriendo?
      live: svc?.live ?? false,
      ts: Date.now(),
      // FASE 13: el endpoint PÚBLICO es mínimo (misión: públicamente
      // { live: true }). Viewers/since/detalle → solo admin autenticado.
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
