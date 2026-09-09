/**
 * Protocolo NDJSON del installer (sidecar de la GUI).
 *
 * Una línea JSON por evento, por stdout. La GUI (Tauri) hace spawn del
 * binario compilado con `--json` y consume estos eventos; las respuestas
 * del usuario (config, confirmaciones) llegan por stdin como líneas JSON:
 *   {"type":"config","config":{…}}       — arranca la instalación
 *   {"type":"uninstall","options":{…}}   — ejecuta uninstall
 *   {"type":"cancel"}                    — aborto cooperativo
 *
 * TODO el progreso/log humano va a STDERR (stdout queda limpio para JSON).
 */
import type { InstallerEvent, EventSink } from "../core/types"

/** EventSink que serializa NDJSON a stdout. */
export function jsonEventSink(): EventSink {
  return (event: InstallerEvent) => {
    process.stdout.write(JSON.stringify(event) + "\n")
  }
}

/** Log humano → stderr (no contamina el protocolo). */
export function humanLog(message: string): void {
  process.stderr.write(`${message}\n`)
}

/** Lee una línea JSON de stdin (respuesta de la GUI). Máx 10 MB; EOF → null. */
export function readGuiMessage(timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buf = ""
    let settled = false
    const done = (v: Record<string, unknown> | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        process.stdin.removeListener("data", onData)
        process.stdin.removeListener("end", onEnd)
        process.stdin.removeListener("close", onEnd)
      } catch {
        /* noop */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    timer.unref?.()
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      if (buf.length > 10 * 1024 * 1024) return done(null)
      const idx = buf.indexOf("\n")
      if (idx !== -1) {
        const line = buf.slice(0, idx).trim()
        try {
          done(line ? (JSON.parse(line) as Record<string, unknown>) : null)
        } catch {
          done(null)
        }
      }
    }
    const onEnd = () => done(null)
    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
    process.stdin.on("close", onEnd)
    process.stdin.resume?.()
  })
}

/** Respuestas posibles de la GUI. */
export type GuiMessage =
  | { type: "config"; config: Record<string, unknown> }
  | { type: "uninstall"; options: Record<string, unknown> }
  | { type: "cancel" }
  | null

export function asGuiMessage(raw: Record<string, unknown> | null): GuiMessage {
  if (!raw || typeof raw.type !== "string") return null
  if (raw.type === "config") return { type: "config", config: (raw.config as Record<string, unknown>) ?? {} }
  if (raw.type === "uninstall") return { type: "uninstall", options: (raw.options as Record<string, unknown>) ?? {} }
  if (raw.type === "cancel") return { type: "cancel" }
  return null
}
