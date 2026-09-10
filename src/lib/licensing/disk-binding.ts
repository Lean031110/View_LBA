/**
 * ViewLBA — Binding de la licencia al DISCO de instalación.
 *
 * Requisito: la licencia se vincula al disco físico donde reside la
 * instalación — NO a la ruta (C:\ es una ruta, no una identidad).
 *
 * Estrategia por SO (con degradación gradual documentada):
 *  · Linux  : UUID del filesystem (findmnt/lsblk / /dev/disk/by-uuid)
 *             + dispositivo + tipo de FS.
 *  · Windows: Número de serie del VOLUMEN (vol X:) — estable del volumen,
 *             no de la letra de unidad.
 *  · macOS  : Volume UUID (diskutil).
 *  · Fallback (contenedores/CI): identidad compuesta del punto de montaje
 *             (se marca como método débil; los tests usan overrides).
 *
 * Se guarda un SHA-256 (diskIdHash) y se muestra solo el ID corto:
 *   DSK-XXXX-XXXX-XXXX (12 hex = 48 bits).
 */
import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { platform } from "node:os"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { sha256Hex } from "./crypto"

const execFileAsync = promisify(execFile)

export interface DiskBinding {
  /** Dispositivo/volumen identificado (p.ej. /dev/sda2, Volume "C:"). */
  device: string
  /** UUID/serial estable del volumen o filesystem (si se obtuvo). */
  uuid: string | null
  /** Tipo de filesystem (ext4, ntfs...) si se conoce. */
  fstype: string | null
  /** Punto de montaje al que pertenece la ruta. */
  mountPoint: string
  /**
   * Método usado (calidad del binding):
   *   findmnt-uuid | lsblk-uuid | by-uuid-symlink | mountinfo | vol-serial |
   *   diskutil-uuid | weak-fallback
   */
  method: string
}

async function runCommand(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 4000, windowsHide: true })
    const out = stdout.trim()
    return out || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function linuxDiskBinding(path: string): Promise<DiskBinding> {
  // 1) findmnt: dispositivo + fstype + UUID del punto de montaje más profundo
  try {
    const out = await runCommand("findmnt", ["-no", "SOURCE,FSTYPE,UUID,TARGET", "-T", path])
    if (out) {
      const [source, fstype, uuid, target] = out.split(/\s+/)
      if (source) {
        return {
          device: source,
          uuid: uuid && uuid !== "-" ? uuid : null,
          fstype: fstype && fstype !== "-" ? fstype : null,
          mountPoint: target ?? "/",
          method: uuid && uuid !== "-" ? "findmnt-uuid" : "mountinfo",
        }
      }
    }
  } catch {}

  // 2) lsblk sobre el dispositivo resuelto por /proc/self/mountinfo
  const info = linuxMountInfoFor(path)
  if (info) {
    const uuid = await lsblkUuid(info.device)
    if (uuid) return { device: info.device, uuid, fstype: info.fstype, mountPoint: info.mountPoint, method: "lsblk-uuid" }
    const byUuid = await uuidBySymlink(info.device)
    if (byUuid) return { device: info.device, uuid: byUuid, fstype: info.fstype, mountPoint: info.mountPoint, method: "by-uuid-symlink" }
    return { device: info.device, uuid: null, fstype: info.fstype, mountPoint: info.mountPoint, method: "mountinfo" }
  }

  // 3) Fallback débil (contenedores sin disco real)
  return weakFallback(path)
}

/** Punto de montaje más profundo que contiene `path` (sin deps). */
function linuxMountInfoFor(path: string): { device: string; fstype: string | null; mountPoint: string } | null {
  try {
    if (!existsSync("/proc/self/mountinfo")) return null
    const lines = readFileSync("/proc/self/mountinfo", "utf8").split("\n")
    let best: { device: string; fstype: string | null; mountPoint: string; depth: number } | null = null
    for (const line of lines) {
      const parts = line.split(" ")
      if (parts.length < 7) continue
      const mountPoint = parts[4]
      const separatorIndex = parts.indexOf("-")
      if (separatorIndex < 0) continue
      const fstype = parts[separatorIndex + 1] ?? null
      const device = parts[separatorIndex + 2] ?? ""
      if (!device.startsWith("/dev/")) continue
      // ¿mountPoint es prefijo de path?
      const p = resolve(path)
      const m = resolve(mountPoint)
      if (p === m || p.startsWith(m + "/")) {
        if (!best || m.length > best.depth) best = { device, fstype, mountPoint: m, depth: m.length }
      }
    }
    return best ? { device: best.device, fstype: best.fstype, mountPoint: best.mountPoint } : null
  } catch {
    return null
  }
}

async function lsblkUuid(device: string): Promise<string | null> {
  return runCommand("lsblk", ["-no", "UUID", device])
}

/** Resuelve el UUID cuyo symlink /dev/disk/by-uuid/<uuid> apunta a `device`. */
async function uuidBySymlink(device: string): Promise<string | null> {
  try {
    const dir = "/dev/disk/by-uuid"
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      const link = `${dir}/${name}`
      try {
        const target = readlinkSync(link) // p.ej. "../../sda2"
        if (resolve(dir, target) === resolve(device)) return name
      } catch {}
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function windowsDiskBinding(path: string): Promise<DiskBinding> {
  const drive = /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : "C:"
  // 1) vol X: → "Volume Serial Number is XXXX-YYYY"
  const out = await runCommand("vol", [drive])
  if (out) {
    const m = out.match(/Volume Serial Number is ([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})/i)
    if (m) {
      return {
        device: `Volume(${drive.toUpperCase()})`,
        uuid: m[1].toUpperCase(),
        fstype: null,
        mountPoint: drive.toUpperCase(),
        method: "vol-serial",
      }
    }
  }
  // 2) wmic (legacy, aún común)
  const wmic = await runCommand("wmic", ["logicaldisk", "where", `DeviceID="${drive}"`, "get", "VolumeSerialNumber"])
  if (wmic) {
    const serial = wmic.split(/\s+/).find((t) => /^[0-9A-Fa-f]{8,16}$/.test(t))
    if (serial) {
      return {
        device: `Volume(${drive.toUpperCase()})`,
        uuid: serial.toUpperCase(),
        fstype: null,
        mountPoint: drive.toUpperCase(),
        method: "vol-serial",
      }
    }
  }
  // 3) Fallback débil
  return weakFallback(path)
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function macosDiskBinding(path: string): Promise<DiskBinding> {
  const out = await runCommand("diskutil", ["info", path])
  if (out) {
    const uuid = out.match(/Volume UUID:\s*(\S+)/)
    const device = out.match(/Device Node:\s*(\S+)/)
    const fstype = out.match(/File System:\s*(\S+)/)
    const mount = out.match(/Mount Point:\s*(.*)$/m)
    if (uuid || device) {
      return {
        device: device?.[1] ?? "unknown",
        uuid: uuid?.[1] ?? null,
        fstype: fstype?.[1] ?? null,
        mountPoint: mount?.[1]?.trim() ?? path,
        method: uuid ? "diskutil-uuid" : "mountinfo",
      }
    }
  }
  return weakFallback(path)
}

// ---------------------------------------------------------------------------
// Fallback débil (contenedores / CI / entornos raros)
// ---------------------------------------------------------------------------

function weakFallback(path: string): DiskBinding {
  // statSync(device id) + ruta — estable dentro del mismo boot/contenedor.
  // En producción real nunca debería llegar aquí (los tests usan overrides).
  let dev = "nodev"
  try {
    const st = statSync(path)
    dev = `stat-dev:${st.dev}`
  } catch {}
  return {
    device: dev,
    uuid: null,
    fstype: null,
    mountPoint: path,
    method: "weak-fallback",
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** Detecta el binding de disco para la ruta indicada. */
export async function detectDiskBinding(path: string): Promise<DiskBinding> {
  const plat = platform()
  if (plat === "linux") return linuxDiskBinding(path)
  if (plat === "win32") return windowsDiskBinding(path)
  if (plat === "darwin") return macosDiskBinding(path)
  return weakFallback(path)
}

/** Hash del binding (SHA-256 hex). Identidad interna completa del disco. */
export function computeDiskIdHash(binding: DiskBinding): string {
  const canonical = [
    `device=${binding.device}`,
    `uuid=${binding.uuid ?? "none"}`,
    `fstype=${binding.fstype ?? "none"}`,
    `mount=${binding.mountPoint}`,
  ].join("|")
  return sha256Hex(`viewlba-disk:v1|${canonical}`)
}

export const DISK_ID_RE = /^DSK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/

/** Deriva el Disk ID público: DSK-XXXX-XXXX-XXXX (6 bytes del hash). */
export function deriveDiskId(diskIdHash: string): string {
  const hex = diskIdHash.slice(0, 12).toUpperCase()
  return `DSK-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

/** Etiqueta amigable del disco para la UX (nunca seriales crudos). */
export function diskLabelOf(binding: DiskBinding): string {
  if (platform() === "win32") {
    return binding.mountPoint.slice(0, 2) // "C:"
  }
  const fs = binding.fstype ? ` · ${binding.fstype}` : ""
  return `${binding.device}${fs}`
}

// ---------------------------------------------------------------------------
// Ruta de instalación
// ---------------------------------------------------------------------------

/**
 * Normaliza una ruta para comparaciones:
 * Windows → mayúscula del drive + resto minúsculas, separadores "/", sin
 * barra final (raíz del drive queda "C:/").
 */
export function normalizeInstallPath(path: string): string {
  const p = path.trim().replace(/\\/g, "/")
  if (/^[A-Za-z]:\//.test(p)) {
    const win = p[0].toUpperCase() + p.slice(1).toLowerCase()
    // sin barra final, salvo la raíz del drive ("C:/")
    return win.length > 3 && win.endsWith("/") ? win.replace(/\/+$/, "") : win
  }
  return p.replace(/\/+$/, "") || "/"
}

/** Ruta de instalación actual (CWD del servidor). */
export function resolveInstallPath(): string {
  const override = process.env.VIEWLBA_TEST_INSTALL_PATH?.trim()
  if (process.env.NODE_ENV !== "production" && override) return override
  return process.cwd()
}

/** Disk ID hash actual con override de test opcional (nunca en producción). */
export async function getDiskIdHashFor(installPath: string): Promise<{ diskIdHash: string; binding: DiskBinding }> {
  const override = process.env.VIEWLBA_TEST_DISK_ID_HASH?.trim()
  if (process.env.NODE_ENV !== "production" && override && /^[0-9a-f]{64}$/.test(override.toLowerCase())) {
    const binding: DiskBinding = {
      device: "test-override",
      uuid: "test-override",
      fstype: "test",
      mountPoint: installPath,
      method: "test-override",
    }
    return { diskIdHash: override.toLowerCase(), binding }
  }
  const binding = await detectDiskBinding(installPath)
  return { diskIdHash: computeDiskIdHash(binding), binding }
}
