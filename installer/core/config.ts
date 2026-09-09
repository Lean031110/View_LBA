/**
 * Validación y normalización de la InstallConfig del usuario.
 *
 * Reglas de la misión:
 *  - defaults razonables (TIMEZONE=America/Havana, puertos 3000/3003/1935/8000);
 *  - NO sobrescribir configuraciones existentes (el merge con .env/instalación
 *    previa lo hace secrets.ts/existing.ts, no aquí);
 *  - validar ANTES de tocar nada.
 */
import { DEFAULT_CONFIG, type InstallConfig } from "./types"
import { suggestSubnet } from "./sysinfo"

export interface ConfigIssue {
  field: string
  message: string
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)?$/
const SUBNET_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/

/** Valida la configuración (pura, testeable). Devuelve issues (vacío = OK). */
export function validateConfig(config: InstallConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!config.restaurantName?.trim()) issues.push({ field: "restaurantName", message: "El nombre del restaurante no puede estar vacío" })
  if (!TZ_RE.test(config.timezone ?? "")) issues.push({ field: "timezone", message: `Zona horaria inválida: ${config.timezone} (formato IANA, p. ej. America/Havana)` })

  const ports: Array<[keyof InstallConfig, number]> = [
    ["webPort", 1],
    ["realtimePort", 1],
    ["rtmpPort", 1],
    ["httpFlvPort", 1],
  ]
  for (const [key] of ports) {
    const v = config[key] as number
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      issues.push({ field: key as string, message: `Puerto inválido: ${v}` })
    }
  }
  const used = [config.webPort, config.realtimePort, config.rtmpPort, config.httpFlvPort]
  const dupes = used.filter((p, i) => used.indexOf(p) !== i)
  if (dupes.length > 0) issues.push({ field: "ports", message: `Puertos duplicados: ${dupes.join(", ")}` })

  if (config.lanSubnet && !SUBNET_RE.test(config.lanSubnet)) {
    issues.push({ field: "lanSubnet", message: `Subred inválida: ${config.lanSubnet} (esperado 192.168.1.0/24)` })
  }
  if (config.adminEmail !== undefined && config.adminEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) {
    issues.push({ field: "adminEmail", message: `Email inválido: ${config.adminEmail}` })
  }
  // La política de contraseñas la impone initializeProduction (server); aquí
  // solo longitud mínima obvia para fallar temprano.
  if (config.adminPassword !== undefined && config.adminPassword !== "" && config.adminPassword.length < 8) {
    issues.push({ field: "adminPassword", message: "La contraseña debe tener al menos 8 caracteres (la política completa se valida al crear el admin)" })
  }
  if (config.offline && config.runBuild) {
    // No es error: build offline con payload precompilado no tiene sentido,
    // se normaliza en normalizeConfig.
  }
  return issues
}

/** Aplica defaults a una config parcial y normaliza. */
export function normalizeConfig(partial: Partial<InstallConfig>, detectedIp?: string | null): InstallConfig {
  const config: InstallConfig = { ...DEFAULT_CONFIG, ...partial }
  config.timezone = config.timezone || DEFAULT_CONFIG.timezone
  config.restaurantName = config.restaurantName?.trim() || DEFAULT_CONFIG.restaurantName
  if (config.lanMode && !config.lanSubnet) {
    config.lanSubnet = suggestSubnet(detectedIp ?? null) ?? undefined
  }
  // offline con build precompilado en el payload → no compilar
  if (config.offline) config.runBuild = false
  return config
}

/** Serializa la config a un .env del servidor (solo claves que el server usa). */
export function configToEnvEntries(config: InstallConfig, layout: { dbUrl: string; mediaDir: string; backupDir: string; logDir: string }): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["PORT", String(config.webPort)],
    ["NODE_ENV", "production"],
    ["TIMEZONE", config.timezone],
    ["DATABASE_URL", layout.dbUrl],
    ["MEDIA_DIR", layout.mediaDir],
    ["BACKUP_DIR", layout.backupDir],
    ["LOG_DIR", layout.logDir],
  ]
  if (config.realtimePort !== 3003) entries.push(["REALTIME_PORT", String(config.realtimePort)])
  if (config.rtmpPort !== 1935) entries.push(["RTMP_PORT", String(config.rtmpPort)])
  if (config.httpFlvPort !== 8000) entries.push(["HTTP_FLV_PORT", String(config.httpFlvPort)])
  return entries
}
