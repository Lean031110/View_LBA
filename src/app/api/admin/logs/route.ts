import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET(req: NextRequest) {
  const auth = await requireAuth("VIEWER")
  if (isNextResponse(auth)) return auth
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500)
  const section = url.searchParams.get("section")

  const items = await db.log.findMany({
    where: section ? { section } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  })
  return NextResponse.json({ items })
}
