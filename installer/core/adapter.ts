/**
 * Contrato ServiceAdapter — la ÚNICA frontera entre el core multiplataforma
 * y el SO. Implementaciones: installer/linux/adapter.ts (systemd) e
 * installer/windows/adapter.ts (NSSM).
 *
 * El core NUNCA llama a systemctl/nssm directamente: todo pasa por aquí,
 * con CmdRunner (→ testeable con RecordingRunner).
 */
import type { CheckResult, EventSink, InstallConfig, Layout, ServiceStatus } from "./types"
import type { CmdRunner, RunOptions } from "./runner"
import type { RollbackRegistry } from "./rollback"

/** Contexto que reciben todas las operaciones del adapter. */
export interface InstallContext {
  config: InstallConfig
  layout: Layout
  runner: CmdRunner
  emit: EventSink
  registry: RollbackRegistry
  /** Entorno ya resuelto (DATABASE_URL incluida) para procesos hijos. */
  env: NodeJS.ProcessEnv
  /** Ruta de bun a usar (binario incluido en el payload o del sistema). */
  bunPath: string
}

export type ServiceAction = "start" | "stop" | "restart" | "status"
export type ServiceSelector = "all" | "app" | "realtime" | "stream"

export interface ServiceAdapter {
  platform: "linux" | "windows"

  /** Checks del SO requeridos por el preflight (systemd / NSSM). */
  checkPlatform(): CheckResult[]

  /** Servicios existentes de una instalación previa (detección). */
  detectExistingServices(layout: Layout, runner?: CmdRunner): ServiceStatus[]

  /**
   * Instalar los 3 servicios (usuario+unidades/timers en linux; NSSM×3 en
   * windows), habilitar arranque automático y arrancar en orden correcto
   * (stream → realtime → app). Registra en registry lo creado.
   */
  installServices(ctx: InstallContext): Promise<void>

  /**
   * Firewall: abrir 3000/3003/1935 a la subred LAN (reglas de la misión y
   * docs/FIREWALL.md). Devuelve checks (warn si no hay ufw/firewalld).
   */
  configureFirewall(ctx: InstallContext): Promise<CheckResult[]>

  /** Gestión diaria (Manager). */
  startAll(ctx: InstallContext, which?: ServiceSelector): Promise<void>
  stopAll(ctx: InstallContext, which?: ServiceSelector): Promise<void>
  restartAll(ctx: InstallContext, which?: ServiceSelector): Promise<void>
  statusAll(ctx: InstallContext): Promise<ServiceStatus[]>

  /** Rollback: detener y quitar SOLO las unidades creadas por el installer. */
  rollbackServices(ctx: InstallContext, units: string[]): Promise<void>

  /** Uninstall: quitar servicios y reglas de firewall (NUNCA datos). */
  removeServices(ctx: InstallContext): Promise<void>

  /** Comando/hint para ver logs (diagnóstico y Manager). */
  logsHint(ctx: InstallContext): string

  /** Rutas de log relevantes para diagnóstico. */
  logPaths(ctx: InstallContext): string[]
}

/** Helper: run con evento "command" (transparencia en UI). */
export function runEmitting(ctx: InstallContext, cmd: string, args: string[], opts: RunOptions = {}): ReturnType<CmdRunner["run"]> {
  ctx.emit({ type: "command", command: cmdArgs(cmd, args) })
  return ctx.runner.run(cmd, args, opts)
}

function cmdArgs(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ")
}
