import { NextRequest, NextResponse } from "next/server"
import { readThemeAsset } from "@/lib/themes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/theme-assets/[themeId]/[name] — asset público de un tema.
 *
 * La TV necesita la imagen de fondo del tema activo. Ruta PÚBLICA (como
 * /api/files) PERO blindada:
 *  · name limitado a [A-Za-z0-9._-]{1,128} y SIN '..' (traversal imposible
 *    por charset + comprobación explícita).
 *  · el asset DEBE estar declarado en la fila validada del tema (nunca se
 *    sirve un archivo no indexado).
 *  · se sirve con Content-Type exacto por extensión validada y sin
 *    Content-Disposition inline de tipos activos.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ themeId: string; name: string }> }) {
  const { themeId, name } = await params

  // Charset duro en ambos segmentos (además del validador interno)
  if (!/^[a-z0-9-]{1,64}$/.test(themeId)) {
    return NextResponse.json({ error: "Tema no válido" }, { status: 400 })
  }

  const asset = await readThemeAsset(themeId, name)
  if (!asset) {
    // Tema/asset inexistente: la TV degrada sin imagen (nunca crash §14)
    return NextResponse.json({ error: "Asset no encontrado" }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.data.length),
      // Cacheable: los assets de tema son inmutables por importación
      // (un re-import genera otro dir aislado; el id cambia de contenido
      // solo tras eliminar+reimportar, y el ETag de /api/content invalida).
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
