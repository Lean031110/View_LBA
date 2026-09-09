/**
 * Diagnóstico estructurado de fallos (misión): fase, comando, error, log,
 * archivo afectado y solución sugerida — en el formato exigido:
 *
 *   STREAM SERVICE
 *   STATUS: FAIL
 *   Motivo:  Port 1935 unavailable.
 *   Acción:  Cambiar puerto o liberar servicio existente.
 */
import type { DiagnosticBlock, InstallPhase } from "./types"

/** Coincidencias de error → sugerencia (evaluadas en orden). */
interface SuggestionRule {
  match: (d: { phase: InstallPhase; error: string }) => boolean
  suggestion: string
}

const RULES: SuggestionRule[] = [
  {
    // ANTES que la regla de prisma: el mismatch es una protección específica
    match: (d) => /target mismatch|another database/i.test(d.error),
    suggestion: "El target de base de datos no coincide (protección anti-DB-ajena). Revisa DATABASE_URL: el installer NO tocará una DB distinta a la del .env verificado.",
  },
  {
    match: (d) => /1935|rtmp/i.test(d.error) && d.phase !== "preflight",
    suggestion: "Port 1935 unavailable. Cambia el puerto RTMP en la configuración o libera el servicio existente que lo ocupa.",
  },
  {
    match: (d) => /3003|socket\.?io|realtime/i.test(d.error),
    suggestion: "El puerto 3003 (realtime) está ocupado o el servicio no arrancó. Cambia REALTIME_PORT o libera el proceso que lo usa.",
  },
  {
    match: (d) => /3000|EADDRINUSE|listen/i.test(d.error),
    suggestion: "El puerto de la app web está ocupado. Cambia el puerto en la configuración o detén el servicio que lo usa.",
  },
  {
    match: (d) => /bun.*(not|no) (found|instal)|ENOENT.*bun/i.test(d.error),
    suggestion: "Bun no está disponible. Usa el paquete oficial (incluye runtime/bun) o instala Bun desde https://bun.sh.",
  },
  {
    match: (d) => /nssm/i.test(d.error),
    suggestion: "NSSM no está disponible. El paquete oficial de Windows lo incluye; si instalas a mano, descarga nssm.cc y pon nssm.exe en el PATH.",
  },
  {
    match: (d) => /systemd/i.test(d.error),
    suggestion: "systemd no está disponible (¿contenedor/WSL?). Instala en un sistema con systemd o usa el arranque manual documentado.",
  },
  {
    match: (d) => /elevat|administrador|root|sudo|permission/i.test(d.error),
    suggestion: "Se requieren permisos administrativos. Ejecuta el installer como root (sudo) o como Administrador de Windows.",
  },
  {
    match: (d) => /prisma|migrate|migration/i.test(d.error),
    suggestion: "La migración falló. Revisa DATABASE_URL en el .env y ejecuta manualmente: bunx prisma migrate deploy (con el mismo .env).",
  },
  {
    match: (d) => /health|timeout|ECONNREFUSED/i.test(d.error) && d.phase === "health",
    suggestion: "Los servicios no respondieron health a tiempo. Consulta el log del servicio indicado y usa «Reparar instalación» tras corregir la causa.",
  },
  {
    match: (d) => /disk|space|ENOSPC/i.test(d.error),
    suggestion: "Espacio en disco insuficiente. Libera ~3 GB o elige otro directorio de instalación.",
  },
  {
    match: (d) => /frozen.?lockfile|lockfile/i.test(d.error),
    suggestion: "El lockfile no coincide con package.json del payload. El installer reintenta con resolución normal; si persiste, el paquete está corrupto — descarga de nuevo.",
  },
]

const DEFAULT_SUGGESTION =
  "Revisa el comando y el log indicados; usa la opción Reparar instalación del installer tras corregir la causa raíz."

/** Construye el diagnóstico con la mejor sugerencia disponible. */
export function buildDiagnostic(input: {
  phase: InstallPhase | "manager" | string
  area?: string
  error: string
  command?: string
  logPath?: string
  affectedFile?: string
}): DiagnosticBlock {
  const error = (input.error ?? "").toString()
  let suggestion = DEFAULT_SUGGESTION
  for (const rule of RULES) {
    try {
      if (rule.match({ phase: input.phase as InstallPhase, error })) {
        suggestion = rule.suggestion
        break
      }
    } catch {
      /* noop */
    }
  }
  return {
    phase: input.phase,
    area: input.area,
    error: error.slice(0, 2000),
    command: input.command,
    logPath: input.logPath,
    affectedFile: input.affectedFile,
    suggestion,
  }
}

/** Render de consola en el formato de la misión. */
export function renderDiagnostic(d: DiagnosticBlock): string {
  const lines: string[] = []
  const area = (d.area ?? d.phase).toUpperCase()
  lines.push(`${area}`)
  lines.push(`STATUS: FAIL`)
  lines.push(`Motivo:   ${d.error}`)
  lines.push(`Acción:   ${d.suggestion}`)
  if (d.command) lines.push(`Comando:  ${d.command}`)
  if (d.logPath) lines.push(`Log:      ${d.logPath}`)
  if (d.affectedFile) lines.push(`Archivo:  ${d.affectedFile}`)
  lines.push(`Fase:     ${d.phase}`)
  return lines.join("\n")
}
