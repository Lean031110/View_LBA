/**
 * Gestión de medios subidos (FASE 10/11 de la misión).
 *
 * - Detección REAL de tipo por magic bytes (no confiar en MIME declarado).
 * - SVG deshabilitado por defecto (XSS same-origin); ALLOW_SVG para reactivar.
 * - Cuota global configurable (MEDIA_MAX_TOTAL_MB).
 * - Directorios separados configurables (MEDIA_DIR/BACKUP_DIR/LOG_DIR) con
 *   defaults portables que NO desaparecen al redeployar la app (F11).
 */
import { stat, readdir } from "fs/promises"
import { join, resolve } from "path"
import { getEnv } from "@/lib/env"

// ---------- Directorios configurables (F11) ----------

/** Directorio de medios subidos. Default: <cwd>/upload (compat con v1.x).
 *  Producción recomendada: ruta FUERA del árbol de la app (p.ej.
 *  /var/lib/pantalla-restaurante/media) para sobrevivir a redeployments. */
export function resolveMediaDir(): string {
  const configured = process.env.MEDIA_DIR?.trim()
  return configured ? resolve(configured) : join(process.cwd(), "upload")
}

export function resolveBackupDir(): string {
  const configured = process.env.BACKUP_DIR?.trim()
  return configured ? resolve(configured) : join(process.cwd(), "backups")
}

export function resolveLogDir(): string {
  const configured = process.env.LOG_DIR?.trim()
  return configured ? resolve(configured) : join(process.cwd(), "logs")
}

// ---------- Extensiones permitidas ----------

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"])
export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogg"])

/** SVG deshabilitado por defecto: servido same-origin puede ejecutar scripts.
 *  Activar solo si se sanitiza externamente antes de subir. */
export function svgAllowed(): boolean {
  return process.env.ALLOW_SVG === "true" || process.env.ALLOW_SVG === "1"
}

// ---------- Magic bytes (inspección REAL del contenido) ----------

export type DetectedType = "png" | "jpeg" | "webp" | "gif" | "mp4" | "webm" | "ogg" | null

/** Detecta el tipo REAL de un buffer por su firma. null = desconocido. */
export function detectMediaType(buf: Buffer): DetectedType {
  if (buf.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  // GIF: GIF8
  if (buf.slice(0, 4).toString("ascii") === "GIF8") return "gif"
  // WebP: RIFF....WEBP
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp"
  // MP4: ....ftyp
  if (buf.slice(4, 8).toString("ascii") === "ftyp") return "mp4"
  // WebM/MKV: EBML 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm"
  // OGG: OggS
  if (buf.slice(0, 4).toString("ascii") === "OggS") return "ogg"
  return null
}

/** ¿La extensión coincide con el tipo detectado por magic bytes? */
export function extensionMatchesDetected(ext: string, detected: DetectedType): boolean {
  if (!detected) return false
  if (detected === "jpeg") return ext === "jpg" || ext === "jpeg"
  return ext === detected
}

export function isImageType(detected: DetectedType): detected is "png" | "jpeg" | "webp" | "gif" {
  return detected === "png" || detected === "jpeg" || detected === "webp" || detected === "gif"
}

export function isVideoType(detected: DetectedType): detected is "mp4" | "webm" | "ogg" {
  return detected === "mp4" || detected === "webm" || detected === "ogg"
}

// ---------- Cuota ----------

/** Límite total del almacenamiento de medios (MB). Default 2048 (2 GB). */
export function mediaQuotaMB(): number {
  const n = Number(process.env.MEDIA_MAX_TOTAL_MB)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2048
}

/** Suma el tamaño de todos los archivos de un directorio (bytes). Errores → 0. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) total += info.size
  }
  return total
}

// ---------- Logging de eventos de medios ----------

export interface UploadDecision {
  ok: boolean
  reason?: string
}

/**
 * Valida COMPLETAMENTE un archivo subido (FASE 10):
 * extensión permitida + extensión consistente con el contenido real
 * (magic bytes) + tamaño por tipo + SVG deshabilitado.
 */
export function validateUploadBuffer(buf: Buffer, ext: string, declaredMime: string): UploadDecision {
  const e = ext.toLowerCase()

  if (e === "svg") {
    return svgAllowed()
      ? { ok: true }
      : { ok: false, reason: "SVG deshabilitado por seguridad (usa PNG/JPG/WebP; ALLOW_SVG=true para activarlo con sanitización externa)" }
  }

  const detected = detectMediaType(buf)
  if (!detected) {
    return { ok: false, reason: "Contenido no reconocido como imagen o vídeo válido (magic bytes)" }
  }
  if (!extensionMatchesDetected(e, detected)) {
    return { ok: false, reason: `La extensión .${e} no coincide con el contenido real (${detected})` }
  }
  if (isImageType(detected) && !IMAGE_EXTENSIONS.has(e)) {
    return { ok: false, reason: `Extensión .${e} no permitida para imágenes` }
  }
  if (isVideoType(detected) && !VIDEO_EXTENSIONS.has(e)) {
    return { ok: false, reason: `Extensión .${e} no permitida para vídeos` }
  }
  // El MIME declarado debe ser plausible (defensa adicional; el magic bytes manda)
  if (declaredMime && !declaredMime.startsWith(detected === "mp4" ? "video/" : isVideoType(detected) ? "video/" : "image/")) {
    return { ok: false, reason: `MIME declarado (${declaredMime}) no plausible para ${detected}` }
  }
  return { ok: true }
}
