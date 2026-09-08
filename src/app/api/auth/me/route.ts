import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })
  return NextResponse.json({ user: { id: user.uid, email: user.email, name: user.name, role: user.role } })
}
