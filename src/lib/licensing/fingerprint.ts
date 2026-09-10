/**
 * ViewLBA — Fingerprint de hardware de la instalación.
 *
 * Objetivo: un identificador ESTABLE que no dependa únicamente de
 * hostname/IP/MAC (valores que cambian con facilidad).
 *
 * Estrategia (documentada en docs/LICENSE-SECURITY.md):
 *  · PRIMARIA: ID de máquina del SO (Linux /etc/machine-id, Windows
 *    MachineGuid del registro, macOS IOPlatformUUID) — sobrevive a cambios
 *    de hostname/IP/tarjetas de red y a reinstalaciones de la app.
 *  · FALLBACK (composite): normalización de múltiples señales (CPU, RAM,
 *    hostname, arquitectura) cuando no hay ID de máquina disponible.
 *  · Se persiste/deriva un SHA-256 — JAMÁS se expone el serial físico crudo.
 *
 * El identificador público (INSTALLATION_ID) es un prefijo del hash:
 *   VWLB-XXXX-XXXX-XXXX-XXXX (16 hex = 64 bits de binding, suficiente para
 *   el modelo de amenaza "anti-copia casual", ver docs/LICENSE-SECURITY.md).
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { hostname, cpus, totalmem, platform, arch, networkInterfaces, homedir } from "node:os"
import { promisify } from "node:util"
import { sha256Hex } from "./crypto"

const execFileAsync = promisify(execFile)

/** Señales de hardware normalizadas (sin seriales crudos completos). */
export interface HardwareFacts {
  machineId: string | null
  cpuModel: string
  cpuCores: number
  totalMem: number
  hostname: string
  platform: string
  arch: string
  macHint: string | null
}

/** Normaliza una señal: minúsculas, sin espacios extremos ni internos. */
function normalizeSignal(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

async function readFileTrim(path: string): Promise<string | null> {
  try {
    if (!existsSync(path)) return null
    const content = readFileSync(path, "utf8").trim()
    return content || null
  } catch {
    return null
  }
}

async function runCommand(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 3000, windowsHide: true })
    const out = stdout.trim()
    return out || null
  } catch {
    return null
  }
}

/** ID de máquina estable según SO. null si no se puede obtener. */
async function readMachineId(): Promise<string | null> {
  if (platform() === "linux") {
    return (await readFileTrim("/etc/machine-id")) ?? (await readFileTrim("/var/lib/dbus/machine-id"))
  }
  if (platform() === "win32") {
    const out = await runCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
    if (!out) return null
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
    return m ? m[1] : null
  }
  if (platform() === "darwin") {
    const out = await runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
    if (!out) return null
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    return m ? m[1] : null
  }
  return null
}

/** MAC de la primera interfaz real no-interna (solo como hint del composite). */
function macHint(): string | null {
  try {
    const ifaces = networkInterfaces()
    for (const list of Object.values(ifaces)) {
      for (const ni of list ?? []) {
        // skip loopback / internas (mac vacío o 00:...)
        if (ni.mac && ni.mac !== "00:00:00:00:00:00" && !ni.internal) return ni.mac.replace(/:/g, "").toLowerCase()
      }
    }
  } catch {}
  return null
}

/** Recopila las señales de hardware disponibles. */
export async function collectHardwareFacts(): Promise<HardwareFacts> {
  const cpuList = cpus()
  return {
    machineId: (await readMachineId())?.toLowerCase() ?? null,
    cpuModel: normalizeSignal(cpuList[0]?.model ?? "unknown-cpu"),
    cpuCores: cpuList.length,
    totalMem: totalmem(),
    hostname: normalizeSignal(hostname()),
    platform: platform(),
    arch: arch(),
    macHint: macHint(),
  }
}

/**
 * Hash del fingerprint (SHA-256 hex, 64 chars) — identidad interna completa.
 * machineId primario; composite solo como fallback.
 */
export function computeDeviceFingerprint(facts: HardwareFacts): string {
  if (facts.machineId) {
    return sha256Hex(`viewlba-device:v1|machine-id|${facts.machineId}`)
  }
  const composite = [
    `cpu=${facts.cpuModel}`,
    `cores=${facts.cpuCores}`,
    `mem=${facts.totalMem}`,
    `host=${facts.hostname}`,
    `plat=${facts.platform}`,
    `arch=${facts.arch}`,
    `mac=${facts.macHint ?? "none"}`,
  ].join("|")
  return sha256Hex(`viewlba-device:v1|composite|${composite}`)
}

/** Método real usado (para metadata/auditoría de calidad del binding). */
export function fingerprintMethodOf(facts: HardwareFacts): "machine-id" | "composite" {
  return facts.machineId ? "machine-id" : "composite"
}

// ---------------------------------------------------------------------------
// Identificador público de instalación
// ---------------------------------------------------------------------------

export const INSTALLATION_ID_RE = /^VWLB-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/

/**
 * Deriva el INSTALLATION_ID público desde el hash completo.
 * Formato: VWLB-XXXX-XXXX-XXXX-XXXX (primeros 8 bytes del SHA-256, hex).
 */
export function deriveInstallationId(deviceIdHash: string): string {
  const hex = deviceIdHash.slice(0, 16).toUpperCase()
  return `VWLB-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

// ---------------------------------------------------------------------------
// Overrides de TEST (solo NODE_ENV != production — nunca en producción)
// ---------------------------------------------------------------------------

const TEST_FP_ENV = "VIEWLBA_TEST_DEVICE_FINGERPRINT"

/** Fingerprint del equipo ACTUAL, con override de test opcional. */
export async function getDeviceFingerprint(): Promise<{ deviceIdHash: string; method: "machine-id" | "composite" }> {
  if (process.env.NODE_ENV !== "production" && process.env[TEST_FP_ENV]?.trim()) {
    const fp = process.env[TEST_FP_ENV]!.trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(fp)) return { deviceIdHash: fp, method: "machine-id" }
  }
  const facts = await collectHardwareFacts()
  return { deviceIdHash: computeDeviceFingerprint(facts), method: fingerprintMethodOf(facts) }
}

/** Home del usuario (para anclas de trial fuera del árbol de la app). */
export function userHome(): string {
  return homedir()
}
