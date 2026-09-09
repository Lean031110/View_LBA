/**
 * ServiceAdapter LINUX — systemd.
 *
 * REUTILIZA las unidades de deploy/linux/*.service|target|timer como
 * PLANTILLAS (misma fuente de verdad que install.sh): se renderizan con
 * sustitución de __BUN_BIN__ y de las rutas del layout (permite directorios
 * personalizados sin duplicar definiciones).
 *
 * Semántica heredada de deploy/linux/install.sh:
 *  - usuario de sistema `pantalla` (sin login, sin root);
 *  - layout FHS + chown/750 de datos y logs;
 *  - daemon-reload + enable (target + timers) + restart;
 *  - arranque en orden (target arranca los tres);
 *  - firewall: ufw/firewalld con las reglas de docs/FIREWALL.md
 *    (3000/3003/1935 a la subred LAN — install.sh original no lo hacía:
 *    el adapter oficial lo añade como warn si no hay gestor).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { CheckResult, Layout, ServiceStatus } from "../core/types"
import { RealRunner, commandExists, type CmdRunner } from "../core/runner"
import type { InstallContext, ServiceAdapter, ServiceSelector } from "../core/adapter"
import { LINUX_DEFAULTS } from "../core/layout"

const UNITS = [
  "pantalla-restaurante.service",
  "pantalla-restaurante-realtime.service",
  "pantalla-restaurante-stream.service",
  "pantalla-restaurante.target",
  "pantalla-restaurante-backup.service",
  "pantalla-restaurante-backup.timer",
  "pantalla-restaurante-logs-purge.service",
  "pantalla-restaurante-logs-purge.timer",
] as const

const DEFAULT_SYSTEMD_DIR = "/etc/systemd/system"

export class LinuxServiceAdapter implements ServiceAdapter {
  readonly platform = "linux" as const

  constructor(private systemdDir: string = DEFAULT_SYSTEMD_DIR) {}

  checkPlatform(): CheckResult[] {
    // systemd real: /run/systemd/system existe si systemd es PID 1 (o contenedor systemd).
    const hasSystemd = existsSync("/run/systemd/system") || existsSync("/var/run/systemd/system")
    const systemctl = existsSync("/bin/systemctl") || existsSync("/usr/bin/systemctl") || existsSync("/bin/systemctl")
    if (hasSystemd) {
      return [{ id: "systemd", label: "systemd disponible", status: "pass" }]
    }
    return [
      {
        id: "systemd",
        label: "systemd NO detectado",
        status: "fail",
        detail: systemctl ? "systemctl existe pero systemd no es el init del sistema" : "sin systemctl",
        hint: "Los servicios 24/7 requieren systemd (no WSL1 ni contenedor básico). Instala en un host Linux con systemd.",
      },
    ]
  }

  detectExistingServices(layout: Layout, runner?: CmdRunner): ServiceStatus[] {
    const r = runner ?? new RealRunner()
    return [
      this.serviceStatus(layout, "app", r),
      this.serviceStatus(layout, "realtime", r),
      this.serviceStatus(layout, "stream", r),
    ]
  }

  private serviceStatus(layout: Layout, key: "app" | "realtime" | "stream", runner: CmdRunner): ServiceStatus {
    const unit = unitName(key)
    const active = runner.run("systemctl", ["is-active", unit, "--quiet"])
    const enabled = runner.run("systemctl", ["is-enabled", unit, "--quiet"])
    return {
      key,
      name: unit,
      active: active.status === 0,
      enabled: enabled.status === 0,
    }
  }

  async installServices(ctx: InstallContext): Promise<void> {
    const { layout, runner, emit, registry } = ctx
    const user = layout.serviceUser ?? LINUX_DEFAULTS.serviceUser

    // 1) Usuario de sistema (sin login, sin root) — idempotente.
    const id = runner.run("id", [user])
    if (id.status !== 0) {
      const r = runner.run("useradd", ["--system", "--home-dir", layout.dataDir, "--shell", "/usr/sbin/nologin", user])
      if (r.status !== 0) {
        throw new Error(`useradd falló: ${(r.stderr || r.stdout).slice(0, 300)} (¿ejecutas como root?)`)
      }
      emit({ type: "info", message: `Usuario de sistema '${user}' creado (sin login, sin root)` })
    }

    // 2) Permisos: datos y logs pertenecen al usuario del servicio.
    for (const dir of [layout.dataDir, layout.logDir]) {
      const chown = runner.run("chown", ["-R", `${user}:${user}`, dir])
      if (chown.status !== 0) throw new Error(`chown falló en ${dir}: ${(chown.stderr || "").slice(0, 200)}`)
      const mod = runner.run("chmod", ["750", dir])
      if (mod.status !== 0) throw new Error(`chmod 750 falló en ${dir}`)
    }
    const appChown = runner.run("chown", ["-R", `${user}:${user}`, layout.appDir])
    if (appChown.status !== 0) throw new Error(`chown falló en ${layout.appDir}`)

    // 3) Render + instalación de unidades (plantillas de deploy/linux).
    const templatesDir = join(layout.appDir, "deploy", "linux")
    if (!existsSync(templatesDir)) {
      throw new Error(`No se encuentran las plantillas systemd en ${templatesDir} (payload incompleto)`)
    }
    for (const unit of UNITS) {
      const src = join(templatesDir, unit)
      if (!existsSync(src)) throw new Error(`Falta la plantilla ${unit} en ${templatesDir}`)
      const rendered = renderUnit(readFileSync(src, "utf8"), {
        bunBin: ctx.bunPath,
        appDir: layout.appDir,
        dataDir: layout.dataDir,
        logDir: layout.logDir,
        envFile: layout.envFile,
        serviceUser: user,
      })
      writeFileSync(join(this.systemdDir, unit), rendered)
      registry.markUnitCreated(unit)
    }
    emit({ type: "info", message: `Unidades systemd renderizadas (${UNITS.length}) en ${this.systemdDir}` })

    // 4) daemon-reload + enable (arranque automático del equipo + timers).
    const reload = runner.run("systemctl", ["daemon-reload"])
    if (reload.status !== 0) throw new Error(`systemctl daemon-reload falló: ${(reload.stderr || "").slice(0, 200)}`)
    for (const unit of ["pantalla-restaurante.target", "pantalla-restaurante-backup.timer", "pantalla-restaurante-logs-purge.timer"]) {
      const en = runner.run("systemctl", ["enable", unit])
      if (en.status !== 0) emit({ type: "warn", message: `no se pudo habilitar ${unit} (¿masked?): ${(en.stderr || "").slice(0, 120)}` })
    }
    registry.markServiceStarted("pantalla-restaurante.target")

    // 5) Arrancar (target = los tres, en sus dependencias correctas).
    const start = runner.run("systemctl", ["restart", "pantalla-restaurante.target"])
    if (start.status !== 0) {
      throw new Error(`systemctl restart pantalla-restaurante.target falló: ${(start.stderr || start.stdout).slice(0, 300)} — revisa journalctl -u pantalla-restaurante`)
    }
    runner.run("systemctl", ["restart", "pantalla-restaurante-backup.timer", "pantalla-restaurante-logs-purge.timer"])
  }

  async configureFirewall(ctx: InstallContext): Promise<CheckResult[]> {
    const { runner, config } = ctx
    const subnet = config.lanSubnet
    const ports: Array<[string, number]> = [
      ["app", config.webPort],
      ["realtime", config.realtimePort],
      ["rtmp", config.rtmpPort],
    ]
    const out: CheckResult[] = []

    // ufw (Debian/Ubuntu)
    if (commandExists("ufw", ["--version"])) {
      for (const [name, port] of ports) {
        const r = runner.run("ufw", subnet ? ["allow", "from", subnet, "to", "any", "port", String(port), "proto", "tcp"] : ["allow", `${port}/tcp`])
        out.push({
          id: `fw-${name}`,
          label: `ufw: ${port}/tcp ${subnet ? `desde ${subnet}` : "(LAN)"}`,
          status: r.status === 0 ? "pass" : "warn",
          detail: r.status === 0 ? undefined : (r.stderr || "").slice(0, 150),
        })
      }
      return out
    }

    // firewalld (RHEL/Fedora) con zona rica por subred
    if (commandExists("firewall-cmd", ["--version"])) {
      const zone = randomZone()
      const add = (args: string[]) => runner.run("firewall-cmd", ["--permanent", ...args])
      if (subnet) {
        add(["--new-zone", zone]) // puede fallar si ya existe → ignorar
        add(["--zone", zone, "--add-source", subnet])
      }
      for (const [name, port] of ports) {
        const r = subnet
          ? add(["--zone", zone, `--add-port=${port}/tcp`])
          : add([`--add-port=${port}/tcp`])
        out.push({
          id: `fw-${name}`,
          label: `firewalld: ${port}/tcp ${subnet ? `en zona ${zone} (${subnet})` : ""}`,
          status: r.status === 0 ? "pass" : "warn",
        })
      }
      const rl = runner.run("firewall-cmd", ["--reload"])
      out.push({ id: "fw-reload", label: "firewalld reload", status: rl.status === 0 ? "pass" : "warn" })
      return out
    }

    // Sin gestor de firewall: warn documentado (misma honestidad que FIREWALL.md)
    out.push({
      id: "fw-manager",
      label: "Sin ufw/firewalld",
      status: "warn",
      detail: "El firewall no se configuró automáticamente",
      hint: `Configura a mano los puertos ${ports.map((p) => p[1]).join(", ")}/tcp para la LAN (docs/FIREWALL.md)`,
    })
    return out
  }

  async startAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    for (const unit of unitsFor(which)) {
      ctx.runner.run("systemctl", ["start", unit])
    }
  }

  async stopAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    // Orden inverso (app → realtime → stream), como manage.sh
    for (const unit of [...unitsFor(which)].reverse()) {
      ctx.runner.run("systemctl", ["stop", unit])
    }
  }

  async restartAll(ctx: InstallContext, which: ServiceSelector = "all"): Promise<void> {
    if (which === "all") {
      ctx.runner.run("systemctl", ["restart", "pantalla-restaurante.target"])
      return
    }
    ctx.runner.run("systemctl", ["restart", unitName(which)])
  }

  async statusAll(ctx: InstallContext): Promise<ServiceStatus[]> {
    return this.detectExistingServices(ctx.layout, ctx.runner)
  }

  async rollbackServices(ctx: InstallContext, units: string[]): Promise<void> {
    const { runner } = ctx
    // 1) Detener solo lo creado por el installer.
    for (const unit of units) {
      if (unit.endsWith(".timer")) runner.run("systemctl", ["stop", unit])
    }
    runner.run("systemctl", ["stop", "pantalla-restaurante.target"])
    for (const unit of units) {
      if (unit.endsWith(".service")) runner.run("systemctl", ["stop", unit])
    }
    // 2) Deshabilitar y quitar SOLO las unidades creadas.
    for (const unit of units) {
      runner.run("systemctl", ["disable", unit])
    }
    for (const unit of units) {
      tryUnlink(join(this.systemdDir, unit))
    }
    runner.run("systemctl", ["daemon-reload"])
    runner.run("systemctl", ["reset-failed"])
  }

  async removeServices(ctx: InstallContext): Promise<void> {
    // Uninstall: quitar TODOS los servicios de ViewLBA (nunca datos).
    const { runner } = ctx
    for (const unit of [...UNITS].reverse()) {
      if (unit.endsWith(".timer")) runner.run("systemctl", ["stop", unit, "--quiet"])
    }
    runner.run("systemctl", ["stop", "pantalla-restaurante.target", "--quiet"])
    for (const unit of UNITS) {
      runner.run("systemctl", ["disable", unit, "--quiet"])
      tryUnlink(join(this.systemdDir, unit))
    }
    runner.run("systemctl", ["daemon-reload"])
    runner.run("systemctl", ["reset-failed"])
  }

  logsHint(_ctx: InstallContext): string {
    return "journalctl -f -t pantalla-restaurante -t pantalla-realtime -t pantalla-stream"
  }

  logPaths(ctx: InstallContext): string[] {
    return [ctx.layout.logDir, "/var/log/journal"]
  }
}

// ---------- helpers ----------

function unitName(key: "app" | "realtime" | "stream"): string {
  if (key === "app") return "pantalla-restaurante.service"
  if (key === "realtime") return "pantalla-restaurante-realtime.service"
  return "pantalla-restaurante-stream.service"
}

function unitsFor(which: ServiceSelector): string[] {
  if (which === "all") {
    return [
      "pantalla-restaurante-stream.service",
      "pantalla-restaurante-realtime.service",
      "pantalla-restaurante.service",
    ]
  }
  return [unitName(which)]
}

/**
 * Render de una unidad: sustituye __BUN_BIN__ y las rutas/usuario del layout.
 * Las plantillas viajan en el payload (deploy/linux/) — única fuente de verdad.
 */
export function renderUnit(
  template: string,
  vars: { bunBin: string; appDir: string; dataDir: string; logDir: string; envFile: string; serviceUser: string }
): string {
  let out = template
  out = out.split("__BUN_BIN__").join(vars.bunBin)
  out = out.split("/opt/pantalla-restaurante").join(vars.appDir)
  out = out.split("/var/lib/pantalla-restaurante").join(vars.dataDir)
  out = out.split("/var/log/pantalla-restaurante").join(vars.logDir)
  out = out.split("/etc/pantalla-restaurante.env").join(vars.envFile)
  out = out.split("User=pantalla").join(`User=${vars.serviceUser}`)
  out = out.split("Group=pantalla").join(`Group=${vars.serviceUser}`)
  return out
}

function tryUnlink(path: string): void {
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    /* noop */
  }
}

function randomZone(): string {
  return `viewlba-${randomBytes(3).toString("hex")}`
}
