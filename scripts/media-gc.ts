/**
 * Limpieza de medios huérfanos (FASE 10).
 *
 * Elimina archivos de MEDIA_DIR que no están referenciados por la DB
 * (Settings.logoUrl/fallback*, Promotion.imageUrl, Dish.imageUrl) y cuya
 * antigüedad supera la gracia configurable (default 7 días).
 *
 * Uso: bun scripts/media-gc.ts [--dry-run] [--grace-days=7]
 */
import { PrismaClient } from "@prisma/client"
import { readdir, stat, unlink } from "fs/promises"
import { join, resolve } from "path"

const db = new PrismaClient()
const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const GRACE_DAYS = Number(args.find((a) => a.startsWith("--grace-days="))?.split("=")[1] ?? 7)

function mediaDir(): string {
  const configured = process.env.MEDIA_DIR?.trim()
  return configured ? resolve(configured) : join(process.cwd(), "upload")
}

/** Extrae el nombre de archivo de una URL /api/files/<name> */
function fileNameOf(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/^\/api\/files\/([A-Za-z0-9._-]+)$/)
  return m ? m[1] : null
}

async function main() {
  const dir = mediaDir()
  const [settings, promos, dishes] = await Promise.all([
    db.settings.findUnique({
      where: { id: "main" },
      select: { logoUrl: true, fallbackImageUrl: true, fallbackVideoUrl: true },
    }),
    db.promotion.findMany({ select: { imageUrl: true } }),
    db.dish.findMany({ select: { imageUrl: true } }),
  ])

  const referenced = new Set<string>()
  for (const url of [settings?.logoUrl, settings?.fallbackImageUrl, settings?.fallbackVideoUrl]) {
    const f = fileNameOf(url)
    if (f) referenced.add(f)
  }
  for (const p of promos) {
    const f = fileNameOf(p.imageUrl)
    if (f) referenced.add(f)
  }
  for (const d of dishes) {
    const f = fileNameOf(d.imageUrl)
    if (f) referenced.add(f)
  }

  const entries = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  let removed = 0
  let freedBytes = 0
  let keptBytes = 0

  for (const name of entries) {
    const full = join(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) continue
    if (referenced.has(name)) {
      keptBytes += info.size
      continue
    }
    const ageDays = (now - info.mtimeMs) / 86_400_000
    if (ageDays < GRACE_DAYS) {
      keptBytes += info.size
      continue
    }
    // huérfano maduro → eliminar
    freedBytes += info.size
    removed += 1
    if (DRY_RUN) {
      console.log(`[dry-run] eliminaría ${name} (${Math.round(info.size / 1024)} KB, ${Math.round(ageDays)}d)`)
    } else {
      await unlink(full).catch(() => {})
      console.log(`✓ eliminado ${name} (${Math.round(info.size / 1024)} KB)`)
    }
  }

  console.log(
    `\nReferenciados: ${referenced.size} · Huérfanos eliminados: ${removed} (${(freedBytes / 1048576).toFixed(1)} MB liberados) · Retenidos: ${(keptBytes / 1048576).toFixed(1)} MB${DRY_RUN ? " · DRY-RUN (nada borrado)" : ""}`
  )
}

main()
  .catch((e) => {
    console.error("Error:", e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
