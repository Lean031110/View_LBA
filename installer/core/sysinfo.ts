/**
 * Información del sistema para la Pantalla 1 del wizard (misión: OS, arch,
 * CPU, RAM, disco, hostname, IP LAN, gateway, permisos administrativos,
 * filesystem) — todo con APIs del runtime, sin comandos externos.
 */
import { arch as osArch, cpus, freemem, hostname, networkInterfaces, platform, totalmem } from "node:os"
import { platform as osPlatform } from "process"
import { existsSync, readFileSync } from "node:fs"
import type { CheckStatus, Platform } from "./types"

export interface SystemInfo {
  platform: Platform | "other"
  os: string
  arch: string
  cpuModel: string
  cpuCores: number
  ramTotalBytes: number
  ramFreeBytes: number
  diskFreeBytes: number | null
  hostname: string
  ipLan: string | null
  gateway: string | null
  elevated: boolean | null
  filesystem: string | null
}

export function detectPlatform(): Platform | "other" {
  if (osPlatform === "linux") return "linux"
  if (osPlatform === "win32") return "windows"
  return "other"
}

/** IP LAN: primera IPv4 no interna (misma heurística que scripts/install.ts). */
export function lanIp(): string | null {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address
      }
    }
  } catch {
    /* noop */
  }
  return null
}

/**
 * Gateway por defecto. Linux: /proc/net/route (hex little-endian, sin
 * comandos). Windows: null (la GUI/CLI lo resuelven vía PowerShell SOLO en
 * modo informativo; el firewall usa la IP/subred detectada).
 */
export function defaultGateway(): string | null {
  try {
    if (osPlatform !== "linux") return null
    if (!existsSync("/proc/net/route")) return null
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/)
      // iface | destination | gateway ...
      if (cols.length < 3 || cols[1] !== "00000000") continue
      const hex = cols[2]
      if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue
      const le = hex.match(/../g)?.reverse().join("") ?? ""
      const ip = [0, 2, 4, 6].map((i) => parseInt(le.slice(i, i + 2), 16)).join(".")
      if (ip !== "0.0.0.0") return ip
    }
  } catch {
    /* noop */
  }
  return null
}

/** ¿Ejecutando con privilegios administrativos? */
export function isElevated(): boolean | null {
  try {
    if (osPlatform === "linux") return typeof process.getuid === "function" && process.getuid() === 0
    if (osPlatform === "win32") {
      // Windows: sin comando externo no es determinista; devolvemos null y
      // el preflight lo comprueba de forma real (runner).
      return null
    }
  } catch {
    /* noop */
  }
  return null
}

/** Subred LAN sugerida (192.168.1.0/24) a partir de la IP detectada. */
export function suggestSubnet(ip: string | null): string | null {
  if (!ip) return null
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
}

/**
 * Convierte la info cruda en checks PASS/WARNING/FAIL (Pantalla 1).
 * Un FAIL crítico (plataforma, RAM, disco, elevación) BLOQUEA el avance.
 */
export interface SystemCheckThresholds {
  minRamBytes?: number
  minDiskBytes?: number
}
export const DEFAULT_THRESHOLDS: Required<SystemCheckThresholds> = {
  minRamBytes: 1 * 1024 ** 3, // 1 GB — MemoryMax del systemd unit es 1G
  minDiskBytes: 3 * 1024 ** 3, // 3 GB (node_modules + build + medios iniciales)
}

export function systemChecks(
  info: SystemInfo,
  diskPath: string,
  freeBytes: number | null,
  thresholds: Required<SystemCheckThresholds> = DEFAULT_THRESHOLDS
): Array<{ id: string; label: string; status: CheckStatus; detail?: string; hint?: string }> {
  const checks: Array<{ id: string; label: string; status: CheckStatus; detail?: string; hint?: string }> = []

  checks.push({
    id: "os",
    label: `Sistema operativo: ${info.os} (${info.arch})`,
    status: info.platform === "linux" || info.platform === "windows" ? "pass" : "fail",
    hint: info.platform === "other" ? "El installer oficial soporta Linux y Windows." : undefined,
  })
  checks.push({
    id: "cpu",
    label: `CPU: ${info.cpuModel} × ${info.cpuCores} núcleos`,
    status: "pass",
  })
  checks.push({
    id: "ram",
    label: `RAM: ${(info.ramTotalBytes / 1024 ** 3).toFixed(1)} GB`,
    status: info.ramTotalBytes >= thresholds.minRamBytes ? "pass" : "warn",
    detail: info.ramTotalBytes >= thresholds.minRamBytes ? undefined : "Por debajo de 1 GB puede degradar la reproducción",
    hint: info.ramTotalBytes >= thresholds.minRamBytes ? undefined : "Añade memoria o reduce la carga de medios",
  })
  checks.push({
    id: "disk",
    label:
      freeBytes === null
        ? `Disco: espacio no medible en ${diskPath}`
        : `Disco: ${(freeBytes / 1024 ** 3).toFixed(1)} GB libres en ${diskPath}`,
    status: freeBytes === null ? "warn" : freeBytes >= thresholds.minDiskBytes ? "pass" : "fail",
    detail: freeBytes === null ? "statfs no disponible — continúa bajo tu responsabilidad" : undefined,
    hint: freeBytes !== null && freeBytes < thresholds.minDiskBytes ? "Libera espacio o elige otro directorio (se necesitan ~3 GB)" : undefined,
  })
  checks.push({ id: "hostname", label: `Hostname: ${info.hostname}`, status: "pass" })
  checks.push({
    id: "ip",
    label: `IP LAN: ${info.ipLan ?? "no detectada"}`,
    status: info.ipLan ? "pass" : "warn",
    hint: info.ipLan ? undefined : "Conecta un cable de red o configura la IP antes de usar las TVs",
  })
  checks.push({
    id: "gateway",
    label: `Gateway: ${info.gateway ?? "no detectado"}`,
    status: info.gateway ? "pass" : "warn",
  })
  if (info.elevated !== null) {
    checks.push({
      id: "elevated",
      label: info.elevated ? "Permisos administrativos: sí" : "Permisos administrativos: NO",
      status: info.elevated ? "pass" : "fail",
      hint: info.elevated ? undefined : "Ejecuta como root (sudo) / Administrador para instalar servicios",
    })
  }
  return checks
}

/** Recolección completa (una llamada). */
export function collectSystemInfo(diskPath: string): SystemInfo {
  const ip = lanIp()
  return {
    platform: detectPlatform(),
    os: `${platform()} ${osArch()}`,
    arch: osArch(),
    cpuModel: cpus()[0]?.model ?? "desconocida",
    cpuCores: cpus().length,
    ramTotalBytes: totalmem(),
    ramFreeBytes: freemem(),
    diskFreeBytes: null,
    hostname: hostname(),
    ipLan: ip,
    gateway: defaultGateway(),
    elevated: isElevated(),
    filesystem: null,
  }
}
