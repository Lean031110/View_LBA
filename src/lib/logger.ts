/**
 * Logger estructurado (FASE 26 de la misión).
 *
 * Salida:
 *   · stdout (una línea JSON por evento — systemd/journald lo captura)
 *   · archivo rotativo por tamaño en LOG_DIR (resolveLogDir de media.ts):
 *     app.log → app.log.1 → … → app.log.5 (5 MB por archivo)
 *
 * Formato: {ts, level, event, actor?, ip?, resource?, resourceId?, success?, …meta}
 *
 * REGLAS DE SEGURIDAD (misión):
 *   · NUNCA contraseñas, secretos, JWT completos ni la clave de stream.
 *   · `redact()` limpia campos peligrosos de cualquier objeto ANTES de
 *     serializar (defensa en profundidad ante errores futuros).
 *   · La clave de stream se trunca a 4 caracteres si algún caller la pasa.
 */
import { appendFileSync, mkdirSync, statSync, existsSync, renameSync, rmSync } from "fs"
import { join } from "path"
import { resolveLogDir } from "@/lib/media"

export type LogLevel = "debug" | "info" | "warn" | "error"

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB por archivo
const MAX_FILES = 5 // app.log + .1 … .4 → renombra fuera el .4 más viejo

/** Campos jamás presentes en un log (se eliminan si llegan por accidente). */
const REDACTED_KEYS = /^(password|passwordhash|secret|token|authorization|cookie|set-cookie|session|jwt|streamkey|internaltoken)$/i
/** Campos que se TRUNCAN (identificables pero nunca completos). */
const TRUNCATED_KEYS = /^(key|streamkey)$/i

/** Sanitiza recursivamente un objeto para logging seguro. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[…]"
  if (value === null || value === undefined) return value
  if (typeof value !== "object") {
    if (typeof value === "string" && value.length > 512) return value.slice(0, 512) + "…"
    return value
  }
  if (Array.isArray(value)) return value.slice(0, 16).map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.test(k)) {
      out[k] = "[REDACTED]"
    } else if (TRUNCATED_KEYS.test(k) && typeof v === "string" && v.length > 0) {
      out[k] = v.slice(0, 4) + "****"
    } else {
      out[k] = redact(v, depth + 1)
    }
  }
  return out
}

let logDirCache: string | null = null
function logDir(): string {
  logDirCache ??= resolveLogDir()
  try {
    mkdirSync(logDirCache, { recursive: true })
  } catch {
    // sin directorio de logs (p. ej. FS readonly) → solo stdout
  }
  return logDirCache
}

/** Rotación por tamaño: app.log → app.log.1 → … (borra el más viejo). */
function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_FILE_BYTES) return
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = `${file}.${i}`
      const to = `${file}.${i + 1}`
      if (existsSync(from)) {
        if (i + 1 >= MAX_FILES + 1) rmSync(from, { force: true })
        else renameSync(from, to)
      }
    }
    renameSync(file, `${file}.1`)
  } catch {
    // rotación best-effort: nunca romper la app por un log
  }
}

export interface LogEventInput {
  event: string
  level?: LogLevel
  actor?: { uid: string; name: string } | null
  ip?: string | null
  resource?: string
  resourceId?: string
  success?: boolean
  meta?: Record<string, unknown>
}

/** Emite UN evento estructurado: stdout + archivo rotativo. */
export function logEvent(input: LogEventInput): void {
  const level = input.level ?? "info"
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event: input.event,
    ...(input.actor ? { actor: { uid: input.actor.uid, name: input.actor.name } } : {}),
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.success !== undefined ? { success: input.success } : {}),
    ...(input.meta ? { meta: redact(input.meta) } : {}),
  })

  // stdout (journald/Docker lo recogen; en dev sale por consola)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)

  // archivo rotativo (best-effort)
  try {
    const file = join(logDir(), "app.log")
    rotateIfNeeded(file)
    appendFileSync(file, line + "\n")
  } catch {
    // sin archivo → stdout ya quedó
  }
}

/** Atajo para errores de operación (reemplaza los .catch(()=>{}) silenciosos). */
export function logError(event: string, err: unknown, extra?: Omit<LogEventInput, "event" | "level">): void {
  logEvent({
    ...extra,
    event,
    level: "error",
    success: false,
    meta: { ...(extra?.meta ?? {}), error: err instanceof Error ? err.message : String(err) },
  })
}
