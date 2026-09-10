import { NextResponse } from "next/server"
import { requireAuth, isNextResponse } from "@/lib/auth"
import { logAction } from "@/lib/crud"
import { createBackup } from "@/lib/backup"
import { requireLicenseFeature } from "@/lib/licensing/guard"

/**
 * POST /api/admin/backup — copia de seguridad manual (FASE 16).
 * Solo ADMIN. Ejecuta VACUUM INTO + verificación de integridad y conteos.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

export async function POST() {
  const auth = await requireAuth("ADMIN")
  if (isNextResponse(auth)) return auth

  // LICENSING: backup manual es premium (backup.selfService)
  const denied = await requireLicenseFeature("backup.selfService")
  if (denied) return denied

  const result = await createBackup()
  await logAction(auth, result.ok ? "BACKUP_CREATED" : "BACKUP_FAILED", "backup", result.ok ? `${result.file} (${Math.round(result.sizeBytes / 1024)} KB)` : (result.error ?? ""))

  if (!result.ok) {
    return NextResponse.json({ error: `Backup fallido: ${result.error}` }, { status: 500 })
  }
  return NextResponse.json({
    ok: true,
    file: result.file,
    sizeBytes: result.sizeBytes,
    integrity: result.integrity,
    tables: result.tables,
    retentionDeleted: result.retentionDeleted,
  })
}
