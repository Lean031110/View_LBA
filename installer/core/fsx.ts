/**
 * Operaciones de filesystem multiplataforma del installer.
 *
 * PROHIBIDO embeber comandos POSIX (cp/rm/mkdir/chown/rsync): todo con las
 * APIs de fs de Node/Bun (regla de la misión). cpSync con recursive para
 * árboles grandes (node_modules) — nativo y rápido.
 */
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"

/** Exclusiones estándar al copiar el servidor (mismas que deploy/linux/install.sh). */
export const SERVER_COPY_EXCLUDES = [
  ".git",
  "node_modules",
  ".next",
  ".install-test",
  "test-results",
  "playwright-report",
  "blob-report",
  "dev.log",
  "server.log",
  ".env",
  "db",
  "upload",
  "uploads",
  "logs",
  "backups",
  "data",
  "dist", // staging del propio empaquetado (evita recursión infinita)
  "download",
]

/** ¿El nombre (archivo o directorio) está excluido? */
export function isExcluded(name: string, excludes: string[]): boolean {
  return excludes.includes(name)
}

/**
 * Copia recursiva con exclusiones por NOMBRE de entrada (archivos y dirs).
 * `extra` permite unir exclusiones base + específicas del caller.
 *
 * TOLERANTE a links (portabilidad): los symlinks/junctions se copian
 * DESREFERENCIADOS (contenido real) si su target existe; los links rotos
 * se omiten sin romper la instalación (visto en CI: next build crea
 * `.next/node_modules` con junctions que se rompen al copiar en Windows).
 */
export function copyDirFiltered(
  src: string,
  dest: string,
  excludes: string[] = SERVER_COPY_EXCLUDES,
  onFile?: (copied: number, current: string) => void
): number {
  if (!existsSync(src)) throw new Error(`copyDirFiltered: no existe ${src}`)
  mkdirSync(dest, { recursive: true })
  let count = 0
  const walk = (from: string, to: string) => {
    let entries
    try {
      entries = readdirSync(from, { withFileTypes: true })
    } catch {
      return // directorio ilegible (link roto): omitir sin romper
    }
    for (const entry of entries) {
      if (isExcluded(entry.name, excludes)) continue
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      let st
      try {
        st = lstatSync(fromPath)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        // ¿apunta a contenido existente? → copiar el CONTENIDO (portable)
        try {
          if (statSync(fromPath).isDirectory()) {
            mkdirSync(toPath, { recursive: true })
            walk(fromPath, toPath)
            count++
          } else if (statSync(fromPath).isFile()) {
            cpSync(fromPath, toPath, { force: true })
            count++
          }
        } catch {
          /* link roto: omitir */
        }
      } else if (st.isDirectory()) {
        mkdirSync(toPath, { recursive: true })
        walk(fromPath, toPath)
      } else if (st.isFile()) {
        cpSync(fromPath, toPath, { force: true })
        count++
        if (onFile && count % 200 === 0) onFile(count, basename(fromPath))
      }
    }
  }
  walk(src, dest)
  return count
}

/** Copia de árbol SIN exclusiones (p. ej. node_modules del payload offline). */
export function copyTree(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`copyTree: no existe ${src}`)
  cpSync(src, dest, { recursive: true, force: true })
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Escribe un archivo con permisos restrictivos (600). Windows: best-effort ACL. */
export function writeFile600(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows usa ACL propias — noop */
  }
}

/** ¿Permisos de escritura en este directorio? (probe real de escritura). */
export function dirWritable(path: string): boolean {
  try {
    const probe = join(path, `.viewlba-probe-${Date.now()}.tmp`)
    writeFileSync(probe, "ok")
    rmSync(probe)
    return true
  } catch {
    return false
  }
}

/** ¿Se puede leer+escribir? (para validar un .env existente). */
export function fileWritable(path: string): boolean {
  try {
    const st = statSync(path)
    return Boolean(st.mode & constants.W_OK)
  } catch {
    return false
  }
}

/**
 * Writability del ANCESTRO más cercano que exista: en una instalación nueva
 * appDir/… todavía no existe — lo que importa es poder crearlo (directorio
 * padre escribible). Camina hacia arriba hasta encontrar algo existente.
 */
export function dirWritableDeep(path: string): boolean {
  let current = path
  for (let i = 0; i < 20; i++) {
    try {
      const st = statSync(current)
      if (st.isDirectory()) return dirWritable(current)
      current = dirnameOf(current)
    } catch {
      const parent = dirnameOf(current)
      if (parent === current) return false
      current = parent
    }
  }
  return false
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (idx <= 0) return idx === 0 ? "/" : p
  return p.slice(0, idx) || "/"
}

/** Borra un directorio SOLO si está vacío (rollback no destructivo). */
export function removeIfEmpty(path: string): boolean {
  try {
    const entries = readdirSync(path)
    if (entries.length > 0) return false
    rmSync(path)
    return true
  } catch {
    return false
  }
}

/** Espacio libre en bytes (best-effort multiplataforma; statfsSync existe en Bun y Node ≥ 19). */
export function freeDiskBytes(path: string): number | null {
  try {
    const st = statfsSync(path) as unknown as { bavail: number; bsize: number }
    return st.bavail * st.bsize
  } catch {
    return null
  }
}
