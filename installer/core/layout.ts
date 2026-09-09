/**
 * Resolución de Layout (rutas de instalación) por plataforma.
 *
 * Defaults = MISMA convención que deploy/linux/install.sh y
 * deploy/windows/install.ps1:
 *   Linux:   /opt/pantalla-restaurante · /var/lib/pantalla-restaurante ·
 *            /var/log/pantalla-restaurante · /etc/pantalla-restaurante.env ·
 *            usuario `pantalla`
 *   Windows: C:\PantallaRestaurante\{app,data,logs} · .env en app\
 */
import type { InstallConfig, Layout, Platform } from "./types"

export const LINUX_DEFAULTS = {
  appDir: "/opt/pantalla-restaurante",
  dataDir: "/var/lib/pantalla-restaurante",
  logDir: "/var/log/pantalla-restaurante",
  envFile: "/etc/pantalla-restaurante.env",
  serviceUser: "pantalla",
}

export const WINDOWS_DEFAULTS = {
  baseDir: "C:\\PantallaRestaurante",
  appDir: "C:\\PantallaRestaurante\\app",
  dataDir: "C:\\PantallaRestaurante\\data",
  logDir: "C:\\PantallaRestaurante\\logs",
  serviceUser: null as string | null,
}

/** Normaliza a slashes normales para file: URLs (Windows-compatible). */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}

/** Construye la DATABASE_URL absoluta (misma disciplina que scripts/install.ts). */
function dbUrlFor(dbFile: string): string {
  return `file:${toForwardSlashes(dbFile)}`
}

/**
 * Resuelve el layout completo. Precedencia: config explícita > defaults del
 * SO. Si installDir está definido en Windows se toma como `baseDir`
 * (C:\...\app C:\...\data C:\...\logs se derivan); en Linux es el appDir y
 * data/log siguen a /var salvo indicación expresa.
 */
export function resolveLayout(platform: Platform, config: Partial<InstallConfig>): Layout {
  if (platform === "linux") {
    const appDir = config.installDir || LINUX_DEFAULTS.appDir
    const dataDir = config.dataDir || LINUX_DEFAULTS.dataDir
    const logDir = config.logDir || LINUX_DEFAULTS.logDir
    const mediaDir = config.mediaDir || `${dataDir}/media`
    const backupDir = config.backupDir || `${dataDir}/backups`
    const dbDir = `${dataDir}/db`
    const envFile = config.envFile ?? defaultLinuxEnvFile(config.installDir)
    const dbFile = `${dbDir}/custom.db`
    return {
      platform,
      appDir,
      dataDir,
      mediaDir,
      backupDir,
      logDir,
      dbDir,
      dbFile,
      dbUrl: dbUrlFor(dbFile),
      envFile,
      serviceUser: LINUX_DEFAULTS.serviceUser,
    }
  }
  // Windows
  const baseDir =
    config.installDir && config.installDir !== WINDOWS_DEFAULTS.appDir
      ? config.installDir.replace(/[\\/](app|data|logs)$/i, "")
      : WINDOWS_DEFAULTS.baseDir
  const appDir = joinWin(baseDir, "app")
  const dataDir = config.dataDir || joinWin(baseDir, "data")
  const logDir = config.logDir || joinWin(baseDir, "logs")
  const mediaDir = config.mediaDir || joinWin(dataDir, "media")
  const backupDir = config.backupDir || joinWin(dataDir, "backups")
  const dbDir = joinWin(dataDir, "db")
  const dbFile = joinWin(dbDir, "custom.db")
  return {
    platform,
    appDir,
    dataDir,
    mediaDir,
    backupDir,
    logDir,
    dbDir,
    dbFile,
    dbUrl: dbUrlFor(dbFile),
    envFile: config.envFile ?? `${appDir}\\.env`,
    serviceUser: null,
  }
}

/** Env file linux: /etc/pantalla-restaurante.env por defecto; con installDir
 *  personalizado se deriva /etc/<nombre>.env (misma convención de install.sh). */
function defaultLinuxEnvFile(installDir?: string): string {
  if (!installDir || toForwardSlashes(installDir) === LINUX_DEFAULTS.appDir) {
    return LINUX_DEFAULTS.envFile
  }
  return linuxEnvFileFor(installDir)
}

/** Env file para layouts linux personalizados: /etc/<nombre>.env derivado del dir. */
function linuxEnvFileFor(appDir: string): string {
  const base = toForwardSlashes(appDir).replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
  return `/etc/${base || "pantalla-restaurante"}.env`
}

function joinWin(a: string, b: string): string {
  return `${a.replace(/[\\/]+$/, "")}\\${b}`
}

/** Crea el set de directorios de datos (nunca borra nada). */
export function layoutDirs(layout: Layout): string[] {
  return [layout.dataDir, layout.dbDir, layout.mediaDir, layout.backupDir, layout.logDir]
}
