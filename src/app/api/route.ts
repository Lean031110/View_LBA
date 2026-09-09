import { NextResponse } from "next/server"

// FASE 35: la raíz /api no expone nada (los endpoints reales están en
// /api/auth/*, /api/admin/*, /api/content, /api/health, /api/stream/*, ...)
export async function GET() {
  return NextResponse.json({ error: "No encontrado" }, { status: 404, headers: { "Cache-Control": "no-store" } })
}
