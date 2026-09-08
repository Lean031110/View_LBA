import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"

// Directorio de subidas relativo a la raíz del proyecto (portable: dev y standalone)
const UPLOAD_DIR = path.join(process.cwd(), "upload")
const MAX_IMAGE = 15 * 1024 * 1024 // 15 MB
const MAX_VIDEO = 120 * 1024 * 1024 // 120 MB

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"])
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg"])

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  try {
    const form = await req.formData()
    const file = form.get("file") as File | null
    if (!file) return NextResponse.json({ error: "Archivo requerido" }, { status: 400 })

    const isImage = IMAGE_TYPES.has(file.type)
    const isVideo = VIDEO_TYPES.has(file.type)
    if (!isImage && !isVideo) {
      return NextResponse.json({ error: "Formato no permitido (imágenes o mp4/webm)" }, { status: 400 })
    }
    const limit = isImage ? MAX_IMAGE : MAX_VIDEO
    if (file.size > limit) {
      return NextResponse.json({ error: `Archivo demasiado grande (máx ${Math.round(limit / 1048576)} MB)` }, { status: 400 })
    }

    const ext = (file.name.split(".").pop() || (isImage ? "png" : "mp4")).toLowerCase().replace(/[^a-z0-9]/g, "")
    const name = `${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`

    await mkdir(UPLOAD_DIR, { recursive: true })
    const buf = Buffer.from(await file.arrayBuffer())
    await writeFile(path.join(UPLOAD_DIR, name), buf)

    await db.log
      .create({ data: { userId: auth.uid, userName: auth.name, action: "UPLOAD", section: "media", details: name } })
      .catch(() => {})

    return NextResponse.json({ ok: true, url: `/api/files/${name}`, name, type: isImage ? "image" : "video" })
  } catch {
    return NextResponse.json({ error: "Error subiendo archivo" }, { status: 500 })
  }
}
