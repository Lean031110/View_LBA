/**
 * Contratos compartidos del installer de ViewLBA Server.
 *
 * Puro: sin stdin, sin process.exit, sin dependencias de SO. Todo lo que
 * toca el sistema (comandos, servicios, firewall) pasa por ServiceAdapter
 * y CmdRunner (ver runner.ts) — así la lógica es testeable en cualquier SO.
 */

/** Resultado de una comprobación (preflight/fase). */
export type CheckStatus = "pass" | "warn" | "fail"

export interface CheckResult {
  id: string
  label: string
  status: CheckStatus
  detail?: string
  /** Qué hacer si no pasa (se muestra en UI/diagnóstico). */
  hint?: string
}

export type Platform = "linux" | "windows"

/** Fases del pipeline de instalación (orden real de ejecución). */
export type InstallPhase =
  | "preflight"
  | "deploy"
  | "environment"
  | "database"
  | "services"
  | "firewall"
  | "health"
  | "admin"
  | "finalize"

export const INSTALL_PHASES: InstallPhase[] = [
  "preflight",
  "deploy",
  "environment",
  "database",
  "services",
  "firewall",
  "health",
  "admin",
  "finalize",
]

export const PHASE_TITLES: Record<InstallPhase, string> = {
  preflight: "Comprobando sistema y dependencias",
  deploy: "Desplegando la aplicación",
  environment: "Configurando entorno y secretos",
  database: "Inicializando base de datos",
  services: "Instalando servicios 24/7",
  firewall: "Configurando firewall (LAN)",
  health: "Verificando salud de la plataforma",
  admin: "Creando el primer administrador",
  finalize: "Finalizando",
}

/** Modo de instalación tras detectar estado previo del equipo. */
export type InstallMode = "new" | "update" | "repair"

/** Configuración elegida por el usuario (wizard/GUI/flags). */
export interface InstallConfig {
  mode: InstallMode
  restaurantName: string
  /** IANA. Default: America/Havana. */
  timezone: string
  /** Puerto web (app Next.js). Default 3000. */
  webPort: number
  /** Socket.io LAN (realtime). Default 3003. */
  realtimePort: number
  /** RTMP ingest (OBS). Default 1935. */
  rtmpPort: number
  /** HTTP-FLV (bind 127.0.0.1). Default 8000. */
  httpFlvPort: number
  /** Directorio de instalación (app). Default por plataforma (layout). */
  installDir?: string
  dataDir?: string
  logDir?: string
  mediaDir?: string
  backupDir?: string
  /** Ruta del .env (default: /etc/… en Linux, app\.env en Windows). */
  envFile?: string
  /** Subred LAN para reglas de firewall, p. ej. 192.168.1.0/24. */
  lanSubnet?: string
  /** Anunciar por IP LAN (true) o localhost (false). */
  lanMode: boolean
  adminEmail?: string
  adminPassword?: string
  withDemoData: boolean
  /** Instalación 100% sin red: el payload debe traer TODO. */
  offline: boolean
  /** Compilar el build de la app (false si el payload trae build). */
  runBuild: boolean
  /** Dónde vive el servidor a instalar (payload). Default: auto-detección. */
  payloadDir?: string
}

export const DEFAULT_CONFIG: InstallConfig = {
  mode: "new",
  restaurantName: "Mi Restaurante",
  timezone: "America/Havana",
  webPort: 3000,
  realtimePort: 3003,
  rtmpPort: 1935,
  httpFlvPort: 8000,
  lanMode: true,
  withDemoData: false,
  offline: false,
  runBuild: true,
}

/** Rutas resueltas de una instalación. */
export interface Layout {
  platform: Platform
  appDir: string
  dataDir: string
  mediaDir: string
  backupDir: string
  logDir: string
  dbDir: string
  dbFile: string
  /** file:... ABSOLUTA (misma disciplina que scripts/install.ts). */
  dbUrl: string
  envFile: string
  /** Usuario de servicio (linux; null en windows). */
  serviceUser: string | null
}

/** Estado de detección de una instalación previa. */
export interface ExistingInstallation {
  envFile: boolean
  hasApp: boolean
  hasDatabase: boolean
  services: ServiceStatus[]
  /** Modo sugerido a partir de lo detectado. */
  suggestedMode: InstallMode
}

export type ServiceKey = "app" | "realtime" | "stream"

export interface ServiceStatus {
  key: ServiceKey | string
  name: string
  active: boolean
  enabled?: boolean
  detail?: string
}

/** Evento del pipeline (NDJSON para la GUI; logs para el CLI). */
export type InstallerEvent =
  | { type: "phase-start"; phase: InstallPhase; title: string }
  | { type: "phase-end"; phase: InstallPhase; status: "ok" | "warn" | "fail"; detail?: string }
  | { type: "check"; result: CheckResult }
  | { type: "info"; message: string }
  | { type: "warn"; message: string }
  | { type: "command"; command: string }
  | { type: "progress"; current: number; total: number; label?: string }
  | { type: "done"; report: InstallReport }
  | { type: "failed"; diagnostic: DiagnosticBlock }

export type EventSink = (event: InstallerEvent) => void

/** Diagnóstico estructurado de un fallo (misma forma que exige la misión). */
export interface DiagnosticBlock {
  phase: InstallPhase | "manager" | string
  area?: string
  /** Comando que falló, si aplica (para reproducirlo a mano). */
  command?: string
  error: string
  logPath?: string
  affectedFile?: string
  /** Solución sugerida — accionable, concreta. */
  suggestion: string
}

/** Reporte de rollback no destructivo. */
export interface RollbackReport {
  ran: boolean
  stoppedServices: string[]
  removedUnits: string[]
  removedEnvFile: boolean
  removedEmptyDirs: string[]
  kept: string[]
  notes: string[]
}

/** Reporte final de la instalación. */
export interface InstallReport {
  ok: boolean
  mode: InstallMode
  layout: Layout
  checks: CheckResult[]
  warnings: string[]
  urls: {
    admin: string
    tv: string
    health: string
    realtime: string
    rtmp: string
  }
  health?: HealthReport
  adminCreated: boolean
  rollback?: RollbackReport
  diagnostic?: DiagnosticBlock
  durationMs: number
}

export interface HealthArea {
  key: "application" | "database" | "storage" | "realtime" | "stream"
  ok: boolean
  detail?: string
}

export interface HealthReport {
  ok: boolean
  /** ok | degraded | unhealthy (semántica de /api/health). */
  status: "ok" | "degraded" | "unhealthy" | "unreachable"
  httpStatus?: number
  areas: HealthArea[]
}
