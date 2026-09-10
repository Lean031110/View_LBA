/**
 * E2E setup (FASE 22) — entorno AISLADO para Playwright.
 *
 *  · DB dedicada `db/e2e.db` — reset COMPLETO en cada ejecución
 *    (nunca toca la DB de desarrollo db/custom.db).
 *  · `prisma migrate deploy` — migraciones versionadas, estilo producción.
 *  · Seed demo + `--with-demo-users` (credenciales DEV-only, nunca producción).
 *  · Usuario VIEWER adicional (matriz de permisos E2E).
 *  · Settings.streamKey FIJA → publicador RTMP ffmpeg de prueba (escenario 14/FASE 23).
 *  · LICENCIA E2E: importa una licencia firmada con la clave DUMMY de test
 *    (e2e/fixtures/licensing) — así los specs existentes (crear pantallas,
 *    usuarios, settings) corren como ACTIVO sin verse afectados por el
 *    gating premium del trial. El trial/gating se prueba en tests unitarios
 *    e de integración dedicados (tests/licensing, tests/integration).
 *
 * Uso: bun scripts/e2e-setup.ts && bunx playwright test
 */
import { execSync } from "child_process"
import { existsSync, rmSync } from "fs"
import { resolve } from "path"
import { randomBytes, scryptSync } from "crypto"
import { PrismaClient } from "@prisma/client"
import { E2E_DEVICE_FINGERPRINT, E2E_DISK_ID_HASH, E2E_INSTALL_PATH, E2E_LICENSE_PUBLIC_KEY } from "../e2e/fixtures/licensing/keys"

const ROOT = resolve(import.meta.dir, "..")
export const E2E_DB_URL = "file:../db/e2e.db" // relativa a prisma/schema.prisma (semántica Prisma)
export const E2E_STREAM_KEY = "e2e-stream-key-0123456789"

function hashPassword(password: string): string {
  // Mismo formato que prisma/seed.ts y src/lib/auth.ts: `${salt}:${scrypt}`
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

function run(cmd: string): void {
  execSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DB_URL },
    stdio: "inherit",
  })
}

// 1) Reset de la DB e2e (archivo + journal/wal/shm)
const dbFile = resolve(ROOT, "db", "e2e.db")
for (const f of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
  if (existsSync(f)) rmSync(f)
}
console.log("✓ DB e2e reseteada:", dbFile)

// 2) Migraciones versionadas (producción-style; JAMÁS db push)
run("bunx prisma migrate deploy")
console.log("✓ Migraciones aplicadas (migrate deploy)")

// 3) Contenido demo + usuarios demo (admin/operador — solo DEV/E2E)
run("bun prisma/seed.ts --with-demo-users")
console.log("✓ Seed demo aplicado")

// 4) Extras del entorno E2E
process.env.DATABASE_URL = E2E_DB_URL
const db = new PrismaClient()
try {
  // VIEWER para la matriz de permisos (escenario 15).
  // Contraseña conforme a la política de FASE 17 (≥10 + mayús/minús/número):
  // #17 cambia y RESTAURA esta contraseña vía API (la API sí valida política).
  await db.user.upsert({
    where: { email: "viewer@restaurante.com" },
    update: { passwordHash: hashPassword("Viewer12345"), role: "VIEWER", active: true, authVersion: 0 },
    create: {
      email: "viewer@restaurante.com",
      name: "Visor E2E",
      passwordHash: hashPassword("Viewer12345"),
      role: "VIEWER",
    },
  })

  // streamKey fija para el publicador ffmpeg de prueba (escenarios 13/14)
  await db.settings.update({
    where: { id: "main" },
    data: {
      streamKey: E2E_STREAM_KEY,
      streamSource: "local",
      streamEnabled: true,
    },
  })
  console.log("✓ VIEWER creado y Settings.streamKey fijada para el publicador de prueba")
} finally {
  await db.$disconnect()
}

// 5) LICENCIA E2E: importar licencia firmada con clave DUMMY de test.
// La identidad de instalación se fija con overrides de test (solo efectivos
// con NODE_ENV != production — el playwright.config los exporta al server).
process.env.VIEWLBA_TEST_DEVICE_FINGERPRINT = E2E_DEVICE_FINGERPRINT
process.env.VIEWLBA_TEST_DISK_ID_HASH = E2E_DISK_ID_HASH
process.env.VIEWLBA_TEST_INSTALL_PATH = E2E_INSTALL_PATH
const { importLicenseZip } = await import("../src/lib/licensing/index")
const { buildE2eLicense, buildE2eLicenseZip } = await import("../e2e/fixtures/licensing/license-builder")
const license = buildE2eLicense({
  customerName: "Restaurante E2E",
  plan: "annual",
  days: 365,
  licenseId: "VLBA-e2e000000001",
})
const importResult = await importLicenseZip(buildE2eLicenseZip(license), {
  actor: { uid: "e2e-setup", name: "E2E Setup" },
  publicKey: E2E_LICENSE_PUBLIC_KEY,
})
if (!importResult.ok) {
  console.error("✗ No se pudo importar la licencia E2E:", importResult.reasons)
  process.exit(1)
}
console.log(`✓ Licencia E2E importada (${license.licenseId} · vence ${license.expiresAt.slice(0, 10)})`)

console.log("✅ Entorno E2E listo (DB: db/e2e.db · usuarios demo admin/operador/viewer · licencia ACTIVA)")
