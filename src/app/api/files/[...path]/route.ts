import { NextRequest, NextResponse } from "next/server"
import { readFile, stat } from "fs/promises"
import path from "path"
import { resolveMediaDir } from "@/lib/media"

// FASE 10/11: serve desde MEDIA_DIR (configurable, fuera del árbol de la app
// en producción); guardas anti path-traversal; SVG neutralizado (nosniff +
// disposition) para que no pueda ejecutarse same-origin.

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
}

/** GET /api/files/<name> — sirve archivos subidos (logo, promos, plato, fallback) */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path: parts } = await params
    const name = parts.join("/")
    const MEDIA_DIR = resolveMediaDir()
    // Guarda anti path-traversal (resolve + prefijo)
    const resolved = path.resolve(MEDIA_DIR, name)
    if (!resolved.startsWith(path.resolve(MEDIA_DIR))) {
      return NextResponse.json({ error: "Ruta inválida" }, { status: 400 })
    }
    const info = await stat(resolved).catch(() => null)
    if (!info || !info.isFile()) {
      return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 })
    }
    const ext = name.split(".").pop()?.toLowerCase() ?? ""
    const data = await readFile(resolved)

    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": "public, max-age=86400, immutable",
      // Nunca dejar que el navegador adivine/transforme el tipo
      "X-Content-Type-Options": "nosniff",
    }
    if (ext === "svg") {
      // SVG residual (subido antes de FASE 10 o con ALLOW_SVG): descargar, no
      // renderizar inline → elimina la vía XSS same-origin
      headers["Content-Disposition"] = "attachment"
    }
    return new NextResponse(new Uint8Array(data), { headers })
  } catch {
    return NextResponse.json({ error: "Error sirviendo archivo" }, { status: 500 })
  }
}
