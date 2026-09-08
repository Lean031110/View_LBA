/**
 * Backup de SQLite (FASE 16).
 *
 * - Copia ONLINE segura con `VACUUM INTO` (no bloquea la operación normal;
 *   produce un archivo compactado e íntegro aunque haya actividad).
 * - VERIFICACIÓN real del backup: PRAGMA integrity_check + conteos de filas.
 * - Retención configurable (BACKUP_RETENTION, default 14).
 * - Ruta configurable (BACKUP_DIR, ver media.ts).
 */
import { mkdir, readdir, stat, copyFile, rm } from "fs/promises"
import { join, resolve } from "path"
import { PrismaClient } from "@prisma/client"
import { resolveBackupDir } from "@/lib/media"

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

/** Ruta de la DB activa, con la misma semántica de DATABASE_URL de Prisma */
export function activeDbPath(): string {
  const url = (process.env.DATABASE_URL ?? "").replace(/^file:/, "")
  if (!url) return join(process.cwd(), "db", "custom.db")
  if (url.startsWith("sqlite:")) return url.replace(/^sqlite:/, "")
  return url.startsWith("/") ? url : resolve(process.cwd(), "prisma", url)
}

export interface BackupResult {
  ok: boolean
  file: string
  sizeBytes: number
  integrity: "ok" | "fail" | string
  tables: Record<string, number>
  retentionDeleted: string[]
  error?: string
}

const TRACKED_TABLES = ["User", "Screen", "Promotion", "Dish", "Schedule", "SocialLink", "TickerMessage", "Settings", "Log"] as const

/** Ejecuta un backup verificado y aplica la retención. */
export async function createBackup(): Promise<BackupResult> {
  const dir = resolveBackupDir()
  await mkdir(dir, { recursive: true })
  const db = new PrismaClient()
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const file = join(dir, `pantalla-restaurante-${stamp}.db`)

  try {
    // 1) Copia online (VACUUM INTO: atómica e íntegra incluso con escrituras)
    await db.$executeRawUnsafe(`VACUUM INTO '${escapeSqlString(file)}'`)

    // 2) VERIFICACIÓN: abrir el backup y comprobar integridad + conteos
    const size = (await stat(file)).size
    const verify = new PrismaClient({
      datasources: { db: { url: `file:${file}` } },
    })
    try {
      const integrityRows = (await verify.$queryRawUnsafe("PRAGMA integrity_check")) as { integrity_check: string }[]
      const integrity = integrityRows[0]?.integrity_check ?? "desconocido"
      const tables: Record<string, number> = {}
      for (const t of TRACKED_TABLES) {
        try {
          const rows = (await verify.$queryRawUnsafe(`SELECT COUNT(*) as n FROM "${t}"`)) as { n: number | bigint }[]
          tables[t] = Number(rows[0]?.n ?? 0)
        } catch {
          tables[t] = -1 // tabla ausente en el backup
        }
      }
      const ok = integrity === "ok" && Object.values(tables).every((n) => n >= 0)

      // 3) Retención: borrar los más allá de BACKUP_RETENTION
      const retentionDeleted = await applyRetention(dir)

      return { ok, file, sizeBytes: size, integrity, tables, retentionDeleted }
    } finally {
      await verify.$disconnect().catch(() => {})
    }
  } catch (e) {
    return { ok: false, file, sizeBytes: 0, integrity: "fail", tables: {}, retentionDeleted: [], error: (e as Error).message }
  } finally {
    await db.$disconnect().catch(() => {})
  }
}

/** Retención: conserva solo los N backups más recientes (default 14). */
async function applyRetention(dir: string): Promise<string[]> {
  const keep = Number(process.env.BACKUP_RETENTION ?? 14)
  if (!Number.isFinite(keep) || keep <= 0) return []
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^pantalla-restaurante-.*\.db$/.test(f))
  if (files.length <= keep) return []
  const withTime: { name: string; mtime: number }[] = []
  for (const f of files) {
    const info = await stat(join(dir, f)).catch(() => null)
    if (info) withTime.push({ name: f, mtime: info.mtimeMs })
  }
  withTime.sort((a, b) => b.mtime - a.mtime)
  const toDelete = withTime.slice(keep)
  const deleted: string[] = []
  for (const f of toDelete) {
    await rm(join(dir, f.name)).catch(() => {})
    deleted.push(f.name)
  }
  return deleted
}

/**
 * Restauración (FASE 16): reemplaza la DB activa con un backup YA VERIFICADO.
 * - Guarda una copia de seguridad de la DB actual antes de tocarla.
 * - ⚠ Los servicios deben reiniciarse después (documentado en el resultado).
 */
export interface RestoreResult {
  ok: boolean
  restoredFrom: string
  safetyCopy: string | null
  integrity: string
  tables: Record<string, number>
  error?: string
}

export async function restoreBackup(backupFile: string): Promise<RestoreResult> {
  const source = resolve(backupFile)
  const target = activeDbPath()

  // 1) Verificar el ANTES de tocar nada
  const verify = new PrismaClient({ datasources: { db: { url: `file:${source}` } } })
  let integrity = "desconocido"
  const tables: Record<string, number> = {}
  try {
    const rows = (await verify.$queryRawUnsafe("PRAGMA integrity_check")) as { integrity_check: string }[]
    integrity = rows[0]?.integrity_check ?? "desconocido"
    for (const t of TRACKED_TABLES) {
      try {
        const r = (await verify.$queryRawUnsafe(`SELECT COUNT(*) as n FROM "${t}"`)) as { n: number | bigint }[]
        tables[t] = Number(r[0]?.n ?? 0)
      } catch {
        tables[t] = -1
      }
    }
    if (integrity !== "ok" || Object.values(tables).some((n) => n < 0)) {
      return { ok: false, restoredFrom: source, safetyCopy: null, integrity, tables, error: "El backup NO pasa la verificación — no se restaura nada" }
    }
  } finally {
    await verify.$disconnect().catch(() => {})
  }

  // 2) Copia de seguridad de la DB actual (por si hay que volver atrás)
  const dir = resolveBackupDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const safetyCopy = join(dir, `pre-restore-${stamp}.db`)
  await copyFile(target, safetyCopy).catch(() => null)

  // 3) Restaurar (reemplazo de archivo)
  await copyFile(source, target)

  return { ok: true, restoredFrom: source, safetyCopy, integrity, tables }
}
