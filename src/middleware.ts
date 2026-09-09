import { NextRequest, NextResponse } from "next/server"

/**
 * FASE 35 — middleware SOLO de cabeceras (cero lógica de auth: la
 * autorización por ruta de FASE 4 sigue intacta y verificada).
 *
 * Las respuestas de APIs privadas (sesión, panel admin) nunca deben ser
 * cacheables por intermediarios (proxys LAN, navegadores):
 *   · /api/auth/*    → datos de sesión (me/login/logout)
 *   · /api/admin/*   → datos del panel (contenido, usuarios, pantallas, logs)
 *   · /api/upload    → resultado de subidas
 *
 * No afecta a /api/content (público, TV), /api/stream/* (streaming en vivo),
 * /api/health (degradado debe verse fresco — sus rutas ya ponen no-store)
 * ni a páginas/estáticos.
 */
export function middleware(_req: NextRequest) {
  const res = NextResponse.next()
  res.headers.set("Cache-Control", "no-store")
  return res
}

export const config = {
  matcher: ["/api/admin/:path*", "/api/auth/:path*", "/api/upload"],
}
