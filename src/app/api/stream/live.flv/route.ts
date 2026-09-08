import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/stream/live.flv — PROXY del stream HTTP-FLV para las pantallas TV.
 *
 * El mini-servicio stream-service publica el FLV en:
 *     http://127.0.0.1:8000/live/<CLAVE>.flv
 * Esa clave NUNCA viaja al navegador: este proxy server-side la añade
 * y transmite el flujo byte a byte (streaming, sin buffering).
 *
 * La pantalla abre mpegts.js sobre esta URL relativa → el video llega por el
 * mismo origen, sin exponer secretos ni depender de Internet.
 *
 * ⚠ El flujo es INFINITO (stream en vivo): no se usa AbortSignal.timeout()
 * en el fetch upstream (abortaría la transmisión a los N segundos). Solo se
 * limita el tiempo de CONEXIÓN y se vigila la inactividad del flujo.
 */
const STREAM_SERVICE_FLV = "http://127.0.0.1:8000"
const CONNECT_TIMEOUT_MS = 5000
const IDLE_TIMEOUT_MS = 15_000 // sin bytes 15s → cortar (el player reintenta)

/** Envuelve el flujo con un watchdog de inactividad (stream vivo 24/7) */
function withIdleTimeout(
  source: ReadableStream<Uint8Array>,
  onAbort: () => void,
  idleMs = IDLE_TIMEOUT_MS
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: TransformStreamDefaultController<Uint8Array> | null = null
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = () => {
    disarm()
    timer = setTimeout(() => {
      // Flujo silencioso demasiado tiempo → cortar y liberar recursos
      try {
        controller?.error(new Error("stream idle timeout"))
      } catch {}
      onAbort()
      source.cancel().catch(() => {})
    }, idleMs)
  }
  // `cancel` forma parte del estándar WHATWG Streams, pero el typedef
  // `Transformer` de algunas versiones de TypeScript no lo declara.
  // Afirmación de tipo segura: el objeto conserva el comportamiento en runtime.
  const transformer = {
    transform(chunk: Uint8Array, ctrl: TransformStreamDefaultController<Uint8Array>) {
      controller = ctrl
      arm()
      ctrl.enqueue(chunk)
    },
    flush() {
      disarm()
    },
    cancel() {
      disarm()
      onAbort()
      source.cancel().catch(() => {})
    },
  } as unknown as Transformer<Uint8Array, Uint8Array>

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer))
}

export async function GET(_req: NextRequest) {
  const settings = await db.settings.findUnique({
    where: { id: "main" },
    select: { streamKey: true, streamSource: true, rtmpApp: true, streamEnabled: true },
  })

  if (!settings?.streamEnabled) {
    return NextResponse.json({ error: "Transmisión deshabilitada" }, { status: 503 })
  }
  if (settings.streamSource !== "local") {
    return NextResponse.json({ error: "La fuente de transmisión no es el servidor local" }, { status: 409 })
  }
  const key = settings.streamKey?.trim()
  if (!key) {
    return NextResponse.json({ error: "No hay clave de transmisión configurada" }, { status: 503 })
  }

  const app = settings.rtmpApp || "live"
  // Timeout SOLO de conexión (headers): el body fluye indefinidamente
  const ac = new AbortController()
  const connectTimer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS)
  const upstream = await fetch(`${STREAM_SERVICE_FLV}/${app}/${encodeURIComponent(key)}.flv`, {
    cache: "no-store",
    headers: { "User-Agent": "signage-flv-proxy/1.0" },
    signal: ac.signal,
  }).catch(() => null)
  clearTimeout(connectTimer)

  if (!upstream || !upstream.ok || !upstream.body) {
    ac.abort() // liberar el socket si quedó abierto
    // Sin publicador (OBS no está transmitiendo) o servicio caído
    return NextResponse.json({ error: "Stream no disponible" }, { status: 503 })
  }

  const body = withIdleTimeout(upstream.body as ReadableStream<Uint8Array>, () => ac.abort())

  // Transmisión en flujo: los headers salen ya y los bytes fluyen conforme llegan.
  // Si el cliente (TV) se desconecta, Next cancela el flujo → se aborta el upstream
  // → node-media-server cierra la sesión de reproducción (viewers se actualizan).
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "video/x-flv",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", // desactivar buffering de proxies inversos
      "Access-Control-Allow-Origin": "*",
    },
  })
}
