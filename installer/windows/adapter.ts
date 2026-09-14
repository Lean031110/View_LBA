/**
 * ServiceAdapter WINDOWS — NSSM.
 *
 * MISMA especificación que deploy/windows/install.ps1 (misión: reutilizar,
 * no duplicar): nombres de servicio, parámetros NSSM (restart 5s, logs con
 * rotación 5MB), reglas netsh y orden de arranque stream → realtime → app.
 *
 * EJECUCIÓN REAL EN WINDOWS: **NOT VERIFIED** (sin Windows en este entorno,
 * regla de la misión). La LÓGICA (secuencia exacta de comandos) se testea
 * con RecordingRunner (tests/installer/windows-adapter.test.ts).
 *
 * Nota: los comandos se emiten como argv directos (nssm.exe / netsh.exe /
 * bun.exe) — sin PowerShell — para ser reproducibles y testeables.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { CheckResult, Layout, ServiceStatus } from "../core/types"
import { commandExists, type CmdRunner } from "../core/runner"
import type { InstallContext, ServiceAdapter, ServiceSelector } from "../core/adapter"
import { WINDOWS_DEFAULTS } from "../core/layout"

export const SERVICE_NAMES = {
  app: "PantallaRestaurante",
  realtime: "PantallaRestauranteRealtime",
  stream: "PantallaRestauranteStream",
} as const

const FIREWALL_RULES = [
  { name: "PantallaRestaurante-App", portKey: "webPort" as const },
  { name: "PantallaRestaurante-Realtime", portKey: "realtimePort" as const },
  { name: "PantallaRestaurante-RTMP", portKey: "rtmpPort" as const },
]

/**
 * NSSM a usar. Raíces probadas en orden (multi-root):
 *   1. <installed appDir>  → app/runtime/nssm.exe (instalación autosuficiente)
 *   2. packageRoot          → runtime/nssm.exe (AppImage CLI) o
 *                             resources/runtime/nssm.exe (NSIS/deb de Tauri)
 *   3. "nssm" del PATH (instalación manual del usuario)
 */
export function resolveNssm(...roots: Array<string | undefined>): string {
  for (const root of roots) {
    if (!root) continue
    for (const sub of [join(root, "app", "runtime"), join(root, "runtime"), join(root, "resources", "runtime")]) {
      const p = join(sub, "nssm.exe")
      if (existsSync(p)) return p
    }
  }
  return "nssm"
}

export class WindowsServiceAdapter implements ServiceAdapter {
  readonly platform = "windows" as const
  private nssmPath: string

  constructor(nssmPath?: string) {
    this.nssmPath = nssmPath ?? resolveNssm()
  }

  checkPlatform(): CheckResult[] {
    if (commandExists(this.nssmPath, ["version"])) {
      return [{ id: "nssm", label: `NSSM disponible (${this.nssmPath})`, status: "pass" }]
    }
    // El nssm DEL PAQUETE (ruta absoluta existente) vale por PRESENCIA: es
    // el contrato del payload oficial (runtime/nssm.exe) y la ejecución se
    // ejercita de verdad al registrar el servicio. Solo el fallback al PATH
    // («nssm» sin ruta) exige verificación por spawn.
    if (this.nssmPath !== "nssm" && existsSync(this.nssmPath)) {
      return [{ id: "nssm", label: `NSSM incluido en el paquete (${this.nssmPath})`, status: "pass" }]
    }
    return [
      {
        id: "nssm",
        label: "NSSM no disponible",
        status: "fail",
        hint: "El paquete oficial de Windows incluye NSSM (resources/runtime/nssm.exe). A mano: choco install -y nssm o descarga de https://nssm.cc",
      },
    ]
  }

  detectExistingServices(_layout: Layout, runner?: CmdRunner): ServiceStatus[] {
    // Detectar con nssm status <name> (SERVICE_RUNNING=1 / STOPPED=... en salida).
    const r = runner ?? { run: (c: string, a: string[]) => fallbackStatus(c, a) }
    return (["app", "realtime", "stream"] as const).map((key) => {
      const name = SERVICE_NAMES[key]
      const res = r.run(this.nssmPath, ["status", name])
      const active = res.status === 0 && /RUNNING/i.test(res.stdout)
      return { key, name, active, detail: res.stdout.trim().slice(0, 60) || undefined }
    })
  }

  async installServices(ctx: InstallContext): Promise<void> {
    const { layout, runner, emit, registry } = ctx
    const bun = ctx.bunPath // absoluto al bundled bun.exe o "bun"

    // 1) Los 3 servicios NSSM (misma configuración que install.ps1).
    this.installSvc(ctx, SERVICE_NAMES.app, layout.appDir, join(layout.appDir, "scripts", "start.ts"), bun)
    this.installSvc(ctx, SERVICE_NAMES.realtime, join(layout.appDir, "mini-services", "realtime-service"), join(layout.appDir, "mini-services", "realtime-service", "index.ts"), bun)
    this.installSvc(ctx, SERVICE_NAMES.stream, layout.dataDir, join(layout.appDir, "mini-services", "stream-service", "index.ts"), bun)
    registry.markServiceStarted(SERVICE_NAMES.stream)
    registry.markServiceStarted(SERVICE_NAMES.realtime)
    registry.markServiceStarted(SERVICE_NAMES.app)

    // 2) Arrancar en orden correcto (stream → realtime → app), como install.ps1.
    for (const name of [SERVICE_NAMES.stream, SERVICE_NAMES.realtime, SERVICE_NAMES.app]) {
      const r = runner.run(this.nssmPath, ["start", name])
      if (r.status !== 0) {
        emit({ type: "warn", message: `nssm start ${name} → ${r.stderr.slice(0, 120)}` })
      }
    }
  }

  /** Instala (o reinstala) un servicio con los parámetros de install.ps1. */
  private installSvc(ctx: InstallContext, name: string, workDir: string, entry: string, bun: string): void {
    const { runner, registry, layout } = ctx
    // idempotente: quitar versión previa (install.ps1 lo hace igual)
    runner.run(this.nssmPath, ["stop", name])
    runner.run(this.nssmPath, ["remove", name, "confirm"])
    const r = runner.run(this.nssmPath, ["install", name, bun, entry])
    if (r.status !== 0 && !/already/i.test(r.stdout + r.stderr)) {
      throw new Error(`nssm install ${name} falló: ${(r.stderr || r.stdout).slice(0, 300)}`)
    }
    registry.markUnitCreated(name)
    const set = (args: string[]) => runner.run(this.nssmPath, ["set", name, ...args])
    set(["AppDirectory", workDir])
    set(["DisplayName", `Pantalla Restaurante — ${name}`])
    set(["Description", "ViewLBA (señalización digital 24/7) — " + name])
    set(["AppRestartDelay", "5000"]) // 24/7: caída → arriba en 5s
    set(["AppStdout", join(layout.logDir, `${name}.log`)])
    set(["AppStderr", join(layout.logDir, `${name}.err.log`)])
    set(["AppRotateFiles", "1"])
    set(["AppRotateBytes", "5242880"]) // rotación 5MB
    set(["Start", "SERVICE_AUTO_START"]) // arranque automático del equipo
  }

  async configureFirewall(ctx: InstallContext): Promise<CheckResult[]> {
    const { runner, config } = ctx
    const out: CheckResult[] = []
    for (const rule of FIREWALL_RULES) {
      const port = config[rule.portKey]
      // Idempotente: borrar la regla previa y volver a crear (install.ps1 igual).
      runner.run("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${rule.name}`])
      const args = [
        "advfirewall",
        "firewall",
        "add",
        "rule",
        `name=${rule.name}`,
        "dir=in",
        "action=allow",
        "protocol=TCP",
        `localport=${port}`,
      ]
      if (config.lanSubnet) args.push(`remoteip=${config.lanSubnet}`)
      const r = runner.run("netsh", args)
      out.push({
        id: `fw-${rule.portKey}`,
        label: `netsh: ${port}/tcp ${config.lanSubnet ? `→ ${config.lanSubnet}` : ""} (${rule.name})`,
        status: r.status === 0 ? "pass" : "warn",
        detail: r.status === 0 ? undefined : (r.stderr || r.stdout).slice(0, 150),
      })
    }
    return out
  }

  async startAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    for (const name of namesFor(which)) {
      ctx.runner.run(this.nssmPath, ["start", name])
    }
  }

  async stopAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    // Orden inverso (app → realtime → stream), como manage.ps1
    for (const name of [...namesFor(which)].reverse()) {
      ctx.runner.run(this.nssmPath, ["stop", name])
    }
  }

  async restartAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    for (const name of namesFor(which)) {
      ctx.runner.run(this.nssmPath, ["restart", name])
    }
  }

  async statusAll(ctx: InstallContext): Promise<ServiceStatus[]> {
    return this.detectExistingServices(ctx.layout, ctx.runner)
  }

  async rollbackServices(ctx: InstallContext, units: string[]): Promise<void> {
    const { runner } = ctx
    // Detener y quitar SOLO los servicios creados por el installer.
    for (const name of units) {
      runner.run(this.nssmPath, ["stop", name])
    }
    for (const name of units) {
      runner.run(this.nssmPath, ["remove", name, "confirm"])
    }
    // Reglas de firewall creadas por el installer.
    for (const rule of FIREWALL_RULES) {
      runner.run("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${rule.name}`])
    }
  }

  async removeServices(ctx: InstallContext): Promise<void> {
    const { runner } = ctx
    for (const name of [...namesFor("all")].reverse()) {
      runner.run(this.nssmPath, ["stop", name])
      runner.run(this.nssmPath, ["remove", name, "confirm"])
    }
    for (const rule of FIREWALL_RULES) {
      runner.run("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${rule.name}`])
    }
  }

  logsHint(_ctx: InstallContext): string {
    return `${WINDOWS_DEFAULTS.logDir}\\PantallaRestaurante.log (y .err.log; rotación 5MB)`
  }

  logPaths(ctx: InstallContext): string[] {
    return [join(ctx.layout.logDir, `${SERVICE_NAMES.app}.log`), join(ctx.layout.logDir, `${SERVICE_NAMES.app}.err.log`)]
  }
}

function namesFor(which: ServiceSelector): string[] {
  if (which === "all") return [SERVICE_NAMES.stream, SERVICE_NAMES.realtime, SERVICE_NAMES.app]
  return [SERVICE_NAMES[which]]
}

/** Fallback de detección sin runner: servicios NO detectados (conservador). */
function fallbackStatus(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string; command: string } {
  void cmd
  void args
  return { status: 1, stdout: "", stderr: "", command: "" }
}
