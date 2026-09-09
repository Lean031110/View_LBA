import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { db } from "@/lib/db"
import { logAction } from "@/lib/crud"
import { logError } from "@/lib/logger"
import {
  resolveMediaDir,
  validateUploadBuffer,
  mediaQuotaMB,
  dirSizeBytes,
} from "@/lib/media"

// FASE 10: límites por tipo + global; validación por MAGIC BYTES (no MIME);
// nombres generados por el servidor (jamás el filename del usuario); cuota.
const MAX_IMAGE = 15 * 1024 * 1024 // 15 MB
const MAX_VIDEO = 120 * 1024 * 1024 // 120 MB

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "ogg", "svg"])

export async function POST(req: NextRequest) {
  const auth = await requireAuth("OPERATOR")
  if (isNextResponse(auth)) return auth

  try {
    const form = await req.formData()
    const file = form.get("file") as File | null
    if (!file) return NextResponse.json({ error: "Archivo requerido" }, { status: 400 })

    // Extensión saneada (el nombre lo genera el servidor; jamás se usa el del usuario)
    const ext = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      await logRejected(auth, file.name, `extensión .${ext || "(ninguna)"} no permitida`)
      return NextResponse.json({ error: "Formato no permitido (imágenes png/jpg/webp/gif o vídeos mp4/webm/ogg)" }, { status: 400 })
    }

    const buf = Buffer.from(await file.arrayBuffer())
    const limit = ext === "svg" || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? MAX_IMAGE : MAX_VIDEO
    if (buf.length === 0 || buf.length > limit) {
      await logRejected(auth, file.name, `tamaño ${buf.length} fuera de límite ${limit}`)
      return NextResponse.json({ error: `Archivo demasiado grande (máx ${Math.round(limit / 1048576)} MB)` }, { status: 400 })
    }

    // FASE 10: validación REAL del contenido (magic bytes + coherencia con extensión)
    const decision = validateUploadBuffer(buf, ext, file.type)
    if (!decision.ok) {
      await logRejected(auth, file.name, decision.reason ?? "contenido inválido")
      return NextResponse.json({ error: decision.reason ?? "Contenido no válido" }, { status: 400 })
    }

    // Cuota global del almacenamiento de medios
    const mediaDir = resolveMediaDir()
    const currentBytes = await dirSizeBytes(mediaDir)
    const quotaBytes = mediaQuotaMB() * 1024 * 1024
    if (currentBytes + buf.length > quotaBytes) {
      await logRejected(auth, file.name, `cuota excedida (${Math.round(currentBytes / 1048576)}/${mediaQuotaMB()} MB)`)
      return NextResponse.json(
        { error: `Cuota de almacenamiento de medios excedida (${mediaQuotaMB()} MB). Elimina archivos antiguos o amplía MEDIA_MAX_TOTAL_MB.` },
        { status: 507 }
      )
    }

    const name = `${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`
    await mkdir(mediaDir, { recursive: true })
    await writeFile(path.join(mediaDir, name), buf)

    await logAction(auth, "UPLOAD_CREATED", "media", `${name} (${Math.round(buf.length / 1024)} KB, ${ext})`, {
      resource: "media",
      resourceId: name,
      meta: { bytes: buf.length, type: ext },
    })

    return NextResponse.json({ ok: true, url: `/api/files/${name}`, name, type: ext === "svg" || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? "image" : "video" })
  } catch (e) {
    logError("UPLOAD_FAILED", e, { resource: "media" })
    return NextResponse.json({ error: "Error subiendo archivo" }, { status: 500 })
  }
}

async function logRejected(auth: { uid: string; name: string }, filename: string, reason: string) {
  await logAction(auth, "UPLOAD_REJECTED", "media", `${String(filename).slice(0, 60)} → ${reason}`.slice(0, 200), {
    resource: "media",
    success: false,
    meta: { reason },
  })
}
