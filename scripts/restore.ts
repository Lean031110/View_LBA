/**
 * Restauración desde CLI (FASE 16): bun scripts/restore.ts --file <backup.db> [--confirm]
 *
 * ⚠ Antes de restaurar: detén la app y los mini-servicios (systemd stop /
 * supervisores). El script guarda una copia pre-restore de la DB actual.
 */
import { restoreBackup } from "../src/lib/backup"

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--")) ?? args.find((a) => a.startsWith("--file="))?.split("=")[1]
const confirm = args.includes("--confirm")

if (!file) {
  console.error("Uso: bun scripts/restore.ts --file <ruta-al-backup.db> --confirm")
  process.exit(1)
}
if (!confirm) {
  console.error("⚠ Restaurar REEMPLAZA la base de datos activa.\n   Añade --confirm para proceder. Se guarda copia pre-restore de la actual.")
  process.exit(1)
}

const r = await restoreBackup(file)
if (r.ok) {
  console.log(`✓ Restauración COMPLETA desde ${r.restoredFrom}`)
  console.log(`  Copia pre-restore: ${r.safetyCopy}`)
  console.log(`  Integridad: ${r.integrity}`)
  const tablas = Object.entries(r.tables).map(([t, n]) => `${t}=${n}`).join(" ")
  console.log(`  Tablas: ${tablas}`)
  console.log("\n▶ REINICIA ahora la app y los mini-servicios (realtime/stream) para que recarguen la DB.")
  console.log("▶ LICENCIA: al reiniciar, la licencia restaurada se revalida contra el hardware/disco actual (MISMATCH si proviene de otra instalación).")
} else {
  console.error("✗ NO se restauró:", r.error)
  process.exit(1)
}
