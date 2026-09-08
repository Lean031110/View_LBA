import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { logAction } from "@/lib/crud"
import { checkSsrfUrl } from "@/lib/ssrf-guard"

/** POST /api/admin/stream-test — verifica desde el servidor que una URL de
 *  stream (m3u8 / mp4 / webm) responde, antes de configurarla en la pantalla.
 *  FASE 12: guard SSRF — el servidor NUNCA fetchea destinos internos salvo
 *  lista explícita (STREAM_TEST_ALLOWED_HOSTS). */
export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth
  const body = await req.json().catch(() => ({}))
  const url = String(body.url ?? "").trim()
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "URL no válida (debe iniciar con http:// o https://)" }, { status: 400 })
  }
  // FASE 12: SSRF guard ANTES del fetch
  const guard = checkSsrfUrl(url)
  if (!guard.allowed) {
    await logAction(auth, "STREAM_TEST_BLOCKED", "stream", `${url.slice(0, 120)} → ${guard.reason}`)
    return NextResponse.json({ error: `Bloqueado por política SSRF: ${guard.reason}` }, { status: 400 })
  }
  const t0 = Date.now()
  try {
    // Para m3u8: validar contenido playlist; para video: HEAD
    const isPlaylist = url.includes(".m3u8")
    const res = await fetch(url, {
      method: isPlaylist ? "GET" : "HEAD",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "SignageHealthCheck/1.0" },
    })
    const latencyMs = Date.now() - t0
    let details = ""
    if (isPlaylist && res.ok) {
      const text = (await res.text()).slice(0, 400)
      details = text.includes("#EXTM3U") ? "Playlist HLS válida" : "Respuesta OK pero no es un M3U8 válido"
    }
    await logAction(auth, "STREAM_TEST", "stream", `${url.slice(0, 120)} → ${res.status} (${latencyMs}ms)`)
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      latencyMs,
      contentType: res.headers.get("content-type"),
      details: details || (res.ok ? "Servidor respondió correctamente" : "El servidor respondió con error"),
    })
  } catch (e) {
    const latencyMs = Date.now() - t0
    await logAction(auth, "STREAM_TEST", "stream", `${url.slice(0, 120)} → ERROR (${latencyMs}ms)`)
    return NextResponse.json({
      ok: false,
      latencyMs,
      error: "No se pudo conectar con el servidor de stream (timeout o red inaccesible)",
    })
  }
}
