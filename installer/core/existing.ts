/**
 * Detección de instalación previa — ANTES de modificar nada (misión:
 * instalación segura). Nunca borra; solo informa y sugiere un modo.
 */
import { existsSync, statSync } from "node:fs"
import { readEnvFile } from "../../scripts/lib/env-file"
import type { ExistingInstallation, InstallMode, Layout, ServiceStatus } from "./types"

export interface ExistingDetectorDeps {
  /** Detectar servicios del SO (systemd units / NSSM). */
  detectServices: (layout: Layout) => ServiceStatus[]
}

export function detectExisting(layout: Layout, deps: ExistingDetectorDeps): ExistingInstallation {
  const envFile = existsSync(layout.envFile)
  const env = envFile ? readEnvFile(layout.envFile) : null
  const hasApp = existsSync(`${layout.appDir}/package.json`)
  // DB "con contenido": archivo existente Y > 0 bytes (un .db de 0 bytes es
  // una instalación a medias, no datos del usuario).
  const hasDatabase = (() => {
    try {
      if (!existsSync(layout.dbFile)) return false
      return statSync(layout.dbFile).size > 0
    } catch {
      return false
    }
  })()
  const services = deps.detectServices(layout)
  const anyService = services.some((s) => s.active || s.enabled)

  // Sugerencia de modo:
  //  - update:   instalación completa funcionando (app + servicios)
  //  - repair:   algo existe pero incompleto (env sin servicios, DB sin app…)
  //  - new:      nada
  const suggestedMode: InstallMode = hasApp && anyService ? "update" : hasApp || envFile || hasDatabase ? "repair" : "new"

  const existing: ExistingInstallation = {
    envFile,
    hasApp,
    hasDatabase,
    services,
    suggestedMode,
  }
  // El env existente NO se muestra con valores: solo claves.
  if (env) {
    Object.defineProperty(existing, "envKeys", { value: Object.keys(env), enumerable: false })
  }
  return existing
}

/** Resumen legible para la UI (sin secretos). */
export function describeExisting(existing: ExistingInstallation): string[] {
  const out: string[] = []
  out.push(existing.hasApp ? `✓ Aplicación ya instalada` : `· Sin aplicación previa`)
  out.push(existing.envFile ? `✓ Archivo de entorno existente (se conservará)` : `· Sin archivo de entorno`)
  out.push(existing.hasDatabase ? `✓ Base de datos EXISTENTE (NO se tocará su contenido)` : `· Sin base de datos previa`)
  const active = existing.services.filter((s) => s.active)
  out.push(active.length > 0 ? `✓ Servicios activos: ${active.map((s) => s.key).join(", ")}` : `· Sin servicios registrados`)
  return out
}
