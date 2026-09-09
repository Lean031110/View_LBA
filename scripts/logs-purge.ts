/**
 * Purga de auditoría (FASE 27) — retención configurable.
 *
 * Borra filas de Log más antiguas que LOG_RETENTION_DAYS (default 90).
 * Uso:  bun scripts/logs-purge.ts [--dry-run]
 *
 * FASE 28 lo programará (systemd timer / tarea programada de Windows).
 * Idempotente y seguro: solo toca la tabla Log, NUNCA contenido.
 */
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS ?? 90))
const DRY = process.argv.includes("--dry-run")

async function main() {
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
  const total = await db.log.count()
  const old = await db.log.count({ where: { createdAt: { lt: cutoff } } })

  if (DRY) {
    console.log(`[dry-run] Logs: ${total} total · ${old} con más de ${DAYS} días (no se borran)`)
    return
  }

  const deleted = await db.log.deleteMany({ where: { createdAt: { lt: cutoff } } })
  console.log(`✓ Purga de auditoría: ${deleted.count} filas eliminadas (> ${DAYS} días) · quedan ${total - deleted.count}`)
}

main()
  .catch((e) => {
    console.error("✗ Error purgando logs:", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
