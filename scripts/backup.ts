/**
 * Backup manual desde CLI (FASE 16): bun scripts/backup.ts
 * (la misma lógica alimenta el botón del panel de administración)
 */
import { createBackup } from "../src/lib/backup"

const r = await createBackup()
if (r.ok) {
  console.log(`✓ Backup VERIFICADO: ${r.file}`)
  console.log(`  Tamaño: ${(r.sizeBytes / 1024).toFixed(1)} KB · Integridad: ${r.integrity}`)
  const tablas = Object.entries(r.tables).map(([t, n]) => `${t}=${n}`).join(" ")
  console.log(`  Tablas: ${tablas}`)
  if (r.retentionDeleted.length > 0) console.log(`  Retención: eliminados ${r.retentionDeleted.length} antiguos`)
} else {
  console.error("✗ Backup FALLIDO:", r.error)
  process.exit(1)
}
