/**
 * Rollback NO destructivo (misión): si una fase falla,
 *  - detener SOLO servicios creados/modificados por el installer;
 *  - conservar datos (DB/media/backups) SIEMPRE;
 *  - conservar el .env si YA existía (solo se borra si lo creamos nosotros);
 *  - borrar directorios creados SOLO si quedaron vacíos;
 *  - informar exactamente qué se revirtió y qué se conservó.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { removeIfEmpty } from "./fsx"
import type { EventSink, RollbackReport } from "./types"

/** Registro de lo que el installer ha creado/modificado (orden real). */
export class RollbackRegistry {
  readonly createdDirs: string[] = []
  private _createdEnvFile: string | null = null
  envFileExistedBefore = false
  /** Unidades/servicios creados por el installer (nombres SO-específicos). */
  readonly createdUnits: string[] = []
  /** Servicios arrancados por el installer. */
  readonly startedServices: string[] = []
  /** Reglas de firewall añadidas por el installer. */
  readonly firewallRules: string[] = []

  get createdEnvFile(): string | null {
    return this._createdEnvFile
  }

  markDirCreated(path: string): void {
    this.createdDirs.push(path)
  }
  markEnvFileCreated(path: string): void {
    this.envFileExistedBefore = false
    this._createdEnvFile = path
  }
  markEnvFilePreExisting(): void {
    this.envFileExistedBefore = true
  }
  markUnitCreated(unit: string): void {
    this.createdUnits.push(unit)
  }
  markServiceStarted(name: string): void {
    this.startedServices.push(name)
  }
  markFirewallRule(name: string): void {
    this.firewallRules.push(name)
  }
}

export interface RollbackDeps {
  /** Detener y quitar SOLO los servicios/unidades creados. */
  rollbackServices: (units: string[]) => Promise<void>
  /** Quitar reglas de firewall añadidas (si el adapter lo soporta). */
  removeFirewallRules?: (rules: string[]) => Promise<void>
  emit?: EventSink
}

/** Ejecuta el rollback conservador. NUNCA lanza: recoge lo que logra. */
export async function performRollback(registry: RollbackRegistry, deps: RollbackDeps): Promise<RollbackReport> {
  const report: RollbackReport = {
    ran: true,
    stoppedServices: [],
    removedUnits: [],
    removedEnvFile: false,
    removedEmptyDirs: [],
    kept: [],
    notes: [],
  }

  // 1) Servicios creados: detener y quitar (el adapter decide cómo).
  if (registry.createdUnits.length > 0) {
    try {
      await deps.rollbackServices(registry.createdUnits)
      report.removedUnits.push(...registry.createdUnits)
    } catch (e) {
      report.notes.push(`No se pudieron quitar todos los servicios: ${(e as Error).message} — quítalos a mano (manage.sh/manage.ps1 uninstall)`)
      report.kept.push(...registry.createdUnits)
    }
  }

  // 2) Firewall: quitar solo las reglas que añadimos.
  if (registry.firewallRules.length > 0 && deps.removeFirewallRules) {
    try {
      await deps.removeFirewallRules(registry.firewallRules)
      report.notes.push(`Reglas de firewall eliminadas: ${registry.firewallRules.join(", ")}`)
    } catch (e) {
      report.notes.push(`No se pudieron quitar las reglas de firewall (${(e as Error).message}); docs/FIREWALL.md explica cómo hacerlo a mano`)
    }
  }

  // 3) .env: SOLO si lo creamos nosotros en esta ejecución.
  if (registry.createdEnvFile && !registry.envFileExistedBefore && existsSync(registry.createdEnvFile)) {
    try {
      rmSync(registry.createdEnvFile)
      report.removedEnvFile = true
    } catch (e) {
      report.notes.push(`No se pudo borrar el .env creado (${(e as Error).message})`)
    }
  } else if (registry.envFileExistedBefore) {
    report.kept.push(registry.createdEnvFile ?? ".env existente")
    report.notes.push("El .env existía ANTES de la instalación: se CONSERVA (podría contener secretos en uso)")
  }

  // 4) Directorios: solo si están VACÍOS (los datos nunca se borran).
  for (const dir of [...registry.createdDirs].reverse()) {
    try {
      if (!existsSync(dir)) continue
      if (hasContent(dir)) {
        report.kept.push(dir)
        continue
      }
      if (removeIfEmpty(dir)) report.removedEmptyDirs.push(dir)
      else report.kept.push(dir)
    } catch {
      report.kept.push(dir)
    }
  }

  // 5) Datos: SIEMPRE conservados.
  report.kept.push("Base de datos, medios y backups: INTACTOS (el rollback nunca toca datos)")

  deps.emit?.({ type: "info", message: "Rollback no destructivo completado (los datos se conservan)" })
  return report
}

function hasContent(dir: string): boolean {
  try {
    const st = statSync(dir)
    if (st.isFile()) return st.size > 0
    return readdirSync(dir).length > 0
  } catch {
    return true // ante la duda: conservar
  }
}
