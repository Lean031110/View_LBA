/**
 * Diagnóstico estructurado de fallos (misión §2): fase, comando, argv,
 * cwd, exit code, stdout, stderr, timeout, servicio afectado, ruta de
 * binario, versión del runtime — en el formato exigido:
 *
 *   STREAM SERVICE
 *   STATUS: FAIL
 *   Motivo:  Port 1935 unavailable.
 *   Acción:  Cambiar puerto o liberar servicio existente.
 *
 * NUNCA registra passwords, tokens ni secretos (ver redactSecrets).
 */
import type { DiagnosticBlock, InstallPhase } from "./types"

/** Patrones de secreto a redactar en stdout/stderr antes de loguear. */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // AUTH_SECRET=valor  (cualquier longitud, comillas o sin)
  { re: /(?<=AUTH_SECRET=)["']?[A-Fa-f0-9]{16,}["']?/gi, replacement: "[REDACTED]" },
  // REALTIME_TOKEN=valor
  { re: /(?<=REALTIME_TOKEN=)["']?[A-Fa-f0-9]{16,}["']?/gi, replacement: "[REDACTED]" },
  // DATABASE_URL con credenciales (postgres://user:pass@)
  { re: /(?<=:\/\/)[^:@/]+:[^:@/]+@/g, replacement: "[USER]:[PASS]@" },
  // password=, pwd=, pass= (case-insensitive, value hasta siguiente & o espacio o fin)
  { re: /(?<=password=)["']?[^\s&"']{4,}["']?/gi, replacement: "[REDACTED]" },
  { re: /(?<=\bpwd=)["']?[^\s&"']{4,}["']?/gi, replacement: "[REDACTED]" },
  // adminPassword=valor (JSON o querystring)
  { re: /(?<=adminPassword["']?\s*[:=]\s*["']?)[^"',}\s]{4,}/gi, replacement: "[REDACTED]" },
  // Bearer tokens
  { re: /(?<=Bearer\s)[A-Za-z0-9._-]{16,}/gi, replacement: "[REDACTED]" },
  // ViewLBA-XXXX-YYYY style admin password (visible en logs)
  { re: /ViewLBA-[A-Fa-f0-9]{8}-[A-Za-z0-9]{2,}/g, replacement: "ViewLBA-[REDACTED]" },
  // github_pat_ tokens (protección belt-and-suspenders)
  { re: /github_pat_[A-Za-z0-9_]{30,}/g, replacement: "github_pat_[REDACTED]" },
]

/** Redacta secretos de un texto antes de incluirlo en logs. */
export function redactSecrets(input: string): string {
  if (!input) return ""
  let out = input
  for (const { re, replacement } of SECRET_PATTERNS) {
    try {
      out = out.replace(re, replacement)
    } catch {
      /* lookahead/lookbehind puede no soportarse en motores viejos: skip */
    }
  }
  return out
}

/** Trunca stdout/stderr a un tamaño seguro para logs. */
const MAX_STDOUT = 4096
const MAX_STDERR = 4096
function truncate(s: string, max: number): string {
  if (!s) return ""
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
}

/** Coincidencias de error → sugerencia (evaluadas en orden). */
interface SuggestionRule {
  match: (d: { phase: InstallPhase; error: string }) => boolean
  suggestion: string
}

const RULES: SuggestionRule[] = [
  // --- REGLAS ESPECÍFICAS PARA LOS ERRORES A/B/C DE LA MISIÓN §2 ---
  // (DEBEN IR ANTES que las reglas genéricas para que el match sea correcto)
  {
    match: (d) => /ParserError|Debe proporcionar una expresión/i.test(d.error),
    suggestion: "PowerShell recibió una línea con escapes rotos (Error A). El installer DEBE usar installer/core/secrets.ts en vez de generar credenciales vía PowerShell pipe.",
  },
  {
    match: (d) => /formato de parámetros incorrecto|FIND:/i.test(d.error),
    suggestion: "El comando `find` de Windows falló (Error B). El installer DEBE consultar SCM vía Win32 API o Get-Service encapsulado en el sidecar, no vía `sc query | find`.",
  },
  {
    match: (d) => /nssm.*usage|uso de nssm|NSSM 2\.24/i.test(d.error),
    suggestion: "NSSM mostró su pantalla de uso (Error C) — fue invocado sin args suficientes. El installer DEBE reemplazar NSSM por un service host Rust nativo (installer/native/windows-service/).",
  },
  // --- REGLAS GENÉRICAS (ordenadas por especificidad descendente) ---
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
  argv?: string[]
  cwd?: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
  timedOut?: boolean
  timeoutMs?: number
  affectedService?: string
  binaryPath?: string
  runtimeVersion?: string
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
    argv: input.argv,
    cwd: input.cwd,
    exitCode: input.exitCode,
    stdout: truncate(redactSecrets(input.stdout ?? ""), MAX_STDOUT),
    stderr: truncate(redactSecrets(input.stderr ?? ""), MAX_STDERR),
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    affectedService: input.affectedService,
    binaryPath: input.binaryPath,
    runtimeVersion: input.runtimeVersion,
    logPath: input.logPath,
    affectedFile: input.affectedFile,
    suggestion,
  }
}

/** Render de consola en el formato de la misión §2 (con todos los campos). */
export function renderDiagnostic(d: DiagnosticBlock): string {
  const lines: string[] = []
  const area = (d.area ?? d.phase).toUpperCase()
  lines.push(`${area}`)
  lines.push(`STATUS: FAIL`)
  lines.push(`Motivo:   ${d.error}`)
  lines.push(`Acción:   ${d.suggestion}`)
  if (d.command) lines.push(`Comando:  ${d.command}`)
  if (d.argv && d.argv.length > 0) lines.push(`Argv:     ${d.argv.join(" ")}`)
  if (d.cwd) lines.push(`Cwd:      ${d.cwd}`)
  if (d.exitCode !== undefined) lines.push(`ExitCode: ${d.exitCode}`)
  if (d.timedOut) lines.push(`Timeout:  HIT (${d.timeoutMs ?? "?"}ms)`)
  else if (d.timeoutMs) lines.push(`Timeout:  ${d.timeoutMs}ms`)
  if (d.affectedService) lines.push(`Servicio: ${d.affectedService}`)
  if (d.binaryPath) lines.push(`Binario:  ${d.binaryPath}`)
  if (d.runtimeVersion) lines.push(`Runtime:  ${d.runtimeVersion}`)
  if (d.logPath) lines.push(`Log:      ${d.logPath}`)
  if (d.affectedFile) lines.push(`Archivo:  ${d.affectedFile}`)
  if (d.stdout) lines.push(`Stdout:   ${d.stdout}`)
  if (d.stderr) lines.push(`Stderr:   ${d.stderr}`)
  lines.push(`Fase:     ${d.phase}`)
  return lines.join("\n")
}

/** Helper: genera un DiagnosticBlock desde un RunResult fallido del runner. */
export function diagnosticFromRunResult(input: {
  phase: InstallPhase | "manager" | string
  area?: string
  command: string
  argv: string[]
  cwd?: string
  result: { status: number | null; stdout: string; stderr: string; command: string }
  timeoutMs?: number
  affectedService?: string
  binaryPath?: string
  runtimeVersion?: string
  logPath?: string
  affectedFile?: string
}): DiagnosticBlock {
  const timedOut = input.result.status === null
  const errorText = timedOut
    ? `Timeout tras ${input.timeoutMs ?? "?"}ms ejecutando: ${input.command} ${input.argv.join(" ")}`
    : (input.result.stderr || input.result.stdout || `Exit code ${input.result.status}`)
  return buildDiagnostic({
    phase: input.phase,
    area: input.area,
    error: errorText,
    command: input.command,
    argv: input.argv,
    cwd: input.cwd,
    exitCode: input.result.status,
    stdout: input.result.stdout,
    stderr: input.result.stderr,
    timedOut,
    timeoutMs: input.timeoutMs,
    affectedService: input.affectedService,
    binaryPath: input.binaryPath,
    runtimeVersion: input.runtimeVersion,
    logPath: input.logPath,
    affectedFile: input.affectedFile,
  })
}
