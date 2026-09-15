/**
 * Ejecución de comandos externos — abstraída para testabilidad.
 *
 * Reglas (heredadas de scripts/lib/production-init.ts):
 *  - env EXPLÍCITO en cada hijo (nunca confiar en el entorno heredado);
 *  - timeout SIEMPRE (un installer colgado es una instalación rota);
 *  - sin shell (spawnSync con argv) → sin inyección de comandos.
 *
 * RecordingRunner: registra los comandos SIN ejecutarlos → tests de lógica
 * (p. ej. la secuencia NSSM de Windows sin Windows) y modo --dry-run.
 */
import { spawnSync } from "node:child_process"
import { reapIfAlive } from "../../scripts/lib/reap"

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Linux: ejecutar como usuario de servicio (sudo -u user -H). */
  runAsUser?: string
  /** Windows: usar shell para .exe del sistema (netsh/nssm resuelven por PATH). */
  shell?: boolean
}

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  /** Comando renderizado para logs/diagnóstico (sin secretos). */
  command: string
}

export interface CmdRunner {
  readonly kind: "real" | "recording"
  run(cmd: string, args: string[], opts?: RunOptions): RunResult
}

export class RealRunner implements CmdRunner {
  readonly kind = "real" as const

  run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
    const command = renderCommand(cmd, args, opts)
    // sudo -u <user> -H <cmd> <args> — solo si NO somos ya ese usuario.
    let finalCmd = cmd
    let finalArgs = args
    if (opts.runAsUser && opts.runAsUser.length > 0 && !runningAsUser(opts.runAsUser)) {
      finalCmd = "sudo"
      finalArgs = ["-u", opts.runAsUser, "-H", cmd, ...args]
    }
    const r = spawnSync(finalCmd, finalArgs, {
      encoding: "utf8",
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 180_000,
      shell: opts.shell ?? false,
      windowsHide: true,
      // stdio[0]="ignore" (lección del 14.º build): ningún hijo del
      // instalador debe esperar stdin — bajo «cmd /c … > install.log» (NSIS)
      // un hijo interactivo colgaría la instalación entera. Doble forma
      // (stdin + stdio[0]): bun admite ambas, node ignora la que no conoce.
      stdin: "ignore",
      stdio: ["ignore", "pipe", "pipe"],
    } as never)
    // Hijo VIVO pese a que spawnSync devolvió (quirk de bun en Windows:
    // pipes cerrados antes que el proceso — 15.º-16.º build: un bun.exe
    // vivo con su árbol mantenía colgada toda la cadena cmd→NSIS→Setup).
    // reapIfAlive usa taskkill /T /F en Windows (mata el árbol del hijo).
    reapIfAlive(r.pid)
    return {
      status: r.status ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      command,
    }
  }
}

/** Registro de comandos (tests / dry-run). Ejecuta NADA. */
export class RecordingRunner implements CmdRunner {
  readonly kind = "recording" as const
  readonly calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = []

  run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
    this.calls.push({ cmd, args, opts })
    return { status: 0, stdout: "", stderr: "", command: renderCommand(cmd, args, opts) }
  }

  /** Todos los comandos renderizados en orden (asserts de tests). */
  rendered(): string[] {
    return this.calls.map((c) => renderCommand(c.cmd, c.args, c.opts ?? {}))
  }
}

/** Render legible de un comando (para eventos/logs — sin contenido de env). */
export function renderCommand(cmd: string, args: string[], opts: RunOptions = {}): string {
  const parts = [cmd, ...args.map((a) => (a.includes(" ") ? `"${a}"` : a))]
  let out = parts.join(" ")
  if (opts.runAsUser) out = `sudo -u ${opts.runAsUser} -- ${out}`
  if (opts.cwd) out = `cd ${opts.cwd} && ${out}`
  return out
}

function runningAsUser(user: string): boolean {
  try {
    return process.getuid?.() === uidOf(user)
  } catch {
    return false
  }
}

function uidOf(_user: string): number {
  // Solo informativo: si no podemos resolver, devolvemos -1 (nunca igual).
  return -1
}

/** ¿El comando existe en PATH? (ENOENT → false; ejecutado → true). */
export function commandExists(cmd: string, args: string[] = ["--version"]): boolean {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, windowsHide: true })
    return !r.error
  } catch {
    return false
  }
}
