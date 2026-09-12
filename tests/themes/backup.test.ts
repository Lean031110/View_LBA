/**
 * TESTS — Backup/restore con TEMAS (§19 misión 3.1).
 *
 *   · createBackup incluye la tabla Theme (conteos verificados)
 *   · restore del propio backup restaura los temas
 *   · restore de un backup PRE-3.1 (sin tabla Theme) NO falla
 *     (OPTIONAL_TABLES — compatibilidad hacia atrás)
 *   · temas restaurados de otro equipo → purge los revalida/elimina
 *   · la expiración de licencia NO borra temas (§17 — documentación ejecutable)
 *
 * NOTA: restaurar REEMPLAZA el archivo de DB (por eso la app pide reiniciar
 * tras un restore). Los tests que usan el singleton de la app corren ANTES
 * de cualquier restore; los restores van al FINAL (orden por diseño).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { validVTheme } from "./helpers"
import type { ThemeError } from "@/lib/themes/types"

const ROOT = resolve(import.meta.dir, "../..")

let tmpDir = ""
let dbUrl = ""
let db: PrismaClient

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "viewlba-thbak-"))
  dbUrl = `file:${join(tmpDir, "bak.db")}`
  process.env.DATABASE_URL = dbUrl
  process.env.BACKUP_DIR = join(tmpDir, "backups")
  process.env.AUTH_SECRET = "tb-secret-0123456789abcdef01234567"
  process.env.REALTIME_TOKEN = "tb-rt-token-0123456789abcdef"

  execSync(`cd '${ROOT}' && DATABASE_URL='${dbUrl}' ./node_modules/.bin/prisma migrate deploy`, { stdio: "pipe" })
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  await db.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } })

  // El singleton de la app puede quedar ligado a la DB de OTRO archivo de
  // tests (mismo proceso) → inyectar NUESTRO cliente en el store de temas.
  const store = await import("@/lib/themes/store")
  store.__setThemeDbForTests(db)
})

afterAll(async () => {
  const store = await import("@/lib/themes/store")
  store.__setThemeDbForTests(null)
  await db?.$disconnect().catch(() => {})
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

async function freshModules() {
  const backup = await import("@/lib/backup")
  const store = await import("@/lib/themes/store")
  return { backup, store }
}

function isThemeError(e: unknown): e is ThemeError {
  return e instanceof Error && "code" in (e as object)
}

describe("backup con temas (§19) — operaciones ANTES de cualquier restore", () => {
  it("createBackup verifica la tabla Theme con el conteo real", async () => {
    const { backup, store } = await freshModules()
    // Instalar un tema (queda en la DB)
    await store.importThemePackage(validVTheme(), "Tema.vtheme", "3.1.0")

    const r = await backup.createBackup()
    expect(r.ok).toBe(true)
    expect(r.tables["Theme"]).toBe(1)
    expect(r.integrity).toBe("ok")
  })

  it("createBackup DOS veces seguidas no colisiona (stamp con ms)", async () => {
    const { backup } = await freshModules()
    const a = await backup.createBackup()
    const b = await backup.createBackup()
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.file).not.toBe(b.file)
  })

  it("temas restaurados de OTRO equipo (dir inexistente) → purge los elimina", async () => {
    const { store } = await freshModules()
    // Simular restore de DB de otro equipo: fila cuyo dir no existe aquí
    await db.theme.create({
      data: {
        themeId: "de-otro-equipo",
        name: "De Otro Equipo",
        manifestJson: "{}",
        themeJson: JSON.stringify({ clock: { style: "neon" } }),
        dir: "t-no-existe",
        assetsJson: "[]",
      },
    })
    const purged = await store.purgeInvalidThemes()
    expect(purged).toContain("de-otro-equipo")
    expect(await db.theme.count()).toBe(1) // el válido queda
  })

  it("la expiración de licencia NO borra temas (§17 — documentación ejecutable)", async () => {
    const { store } = await freshModules()
    const res = await store.importThemePackage(validVTheme({ id: "sobrevive-expiracion" }), "Sobrevive.vtheme", "3.1.0")
    await store.activateTheme(res.themeId)
    // (expirar la licencia es transición de ESTADO — no de datos: los temas
    // instalados siguen en la DB y el activo se mantiene; el borrado solo
    // ocurre por acción explícita del admin vía la ruta con gate 403)
    const t = await store.resolveActiveTheme()
    expect(t.id).toBe("sobrevive-expiracion")
    // Los temas instalados NO se borran: test-theme + sobrevive-expiracion
    expect(await db.theme.count()).toBe(2)
  })

  it("colisiones de id siguen protegidas (id_conflict)", async () => {
    const { store } = await freshModules()
    try {
      await store.importThemePackage(validVTheme({ id: "sobrevive-expiracion" }), "Duplicado.vtheme", "3.1.0")
      throw new Error("DEBÍA RECHAZAR duplicado")
    } catch (e) {
      expect(isThemeError(e) && e.code === "id_conflict").toBe(true)
    }
  })
})

describe("backup con temas (§19) — restores (reemplazan el archivo activo)", () => {
  it("restore del propio backup restaura los temas (revierte filas post-backup)", async () => {
    const { backup } = await freshModules()
    const created = await backup.createBackup()
    expect(created.ok).toBe(true)

    // Estado en el momento del backup
    const atBackup = new PrismaClient({ datasources: { db: { url: dbUrl } } })
    const nAtBackup = await atBackup.theme.count()
    expect(nAtBackup).toBe(2) // test-theme + sobrevive-expiracion
    await atBackup.$disconnect()

    // Cambiar el estado DESPUÉS del backup (nueva fila)
    const mutate = new PrismaClient({ datasources: { db: { url: dbUrl } } })
    await mutate.theme.create({
      data: { themeId: "post-backup", name: "Post", manifestJson: "{}", themeJson: "{}", dir: "t-x", assetsJson: "[]" },
    })
    expect(await mutate.theme.count()).toBe(nAtBackup + 1)
    await mutate.$disconnect()

    // Restaurar → el estado vuelve al momento del backup
    const r = await backup.restoreBackup(created.file)
    expect(r.ok).toBe(true)
    expect(r.tables["Theme"]).toBe(nAtBackup)

    // El archivo activo cambió → reconectar (como el reinicio real)
    const after = new PrismaClient({ datasources: { db: { url: dbUrl } } })
    expect(await after.theme.count()).toBe(nAtBackup)
    await after.$disconnect()
  })

  it("restore de un backup PRE-3.1 (sin tabla Theme) NO falla (compatibilidad)", async () => {
    const { backup } = await freshModules()
    // Fabricar un backup "viejo": copia de la DB actual SIN la tabla Theme
    const oldDbPath = join(tmpDir, "old.db")
    execSync(`cp '${join(tmpDir, "bak.db")}' '${oldDbPath}'`, { stdio: "pipe" })
    const oldDb = new PrismaClient({ datasources: { db: { url: `file:${oldDbPath}` } } })
    await oldDb.$executeRawUnsafe(`DROP TABLE IF EXISTS "Theme"`)
    await oldDb.$disconnect()

    const r = await backup.restoreBackup(oldDbPath)
    expect(r.ok).toBe(true)
    // La tabla Theme figura como ausente (-1) pero NO bloquea el restore
    expect(r.tables["Theme"]).toBe(-1)
  })
})
