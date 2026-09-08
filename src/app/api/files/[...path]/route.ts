import { NextRequest, NextResponse } from "next/server"
import { readFile, stat } from "fs/promises"
import path from "path"

// Directorio de subidas relativo a la raíz del proyecto (portable: dev y standalone)
const UPLOAD_DIR = path.join(process.cwd(), "upload")

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
    // Guarda anti path-traversal
    const resolved = path.resolve(UPLOAD_DIR, name)
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
      return NextResponse.json({ error: "Ruta inválida" }, { status: 400 })
    }
    const info = await stat(resolved).catch(() => null)
    if (!info || !info.isFile()) {
      return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 })
    }
    const ext = name.split(".").pop()?.toLowerCase() ?? ""
    const data = await readFile(resolved)
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Length": String(info.size),
        "Cache-Control": "public, max-age=86400, immutable",
      },
    })
  } catch {
    return NextResponse.json({ error: "Error sirviendo archivo" }, { status: 500 })
  }
}
