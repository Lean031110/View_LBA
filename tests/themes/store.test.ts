/**
 * TESTS — Almacenamiento de temas (DB real + directorio aislado real).
 *
 * Cubre: instalación aislada · activación (colores + broadcast) ·
 * eliminación protegida · fallback automático a Default (§14) · purge
 * post-restore (§19) · servir assets con defensa anti-traversal.
 *
 * Entorno: DB SQLite temporal con migraciones reales + THEME_DIR temporal.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { validVTheme, classicVTheme, baseManifest, baseSpec, makePng } from "./helpers"
import { writeZip } from "@/lib/themes/zip"
import type { ThemeError } from "@/lib/themes/types"

const ROOT = resolve(import.meta.dir, "../..")

let tmpDir = ""
let dbUrl = ""
let db: PrismaClient

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "viewlba-themes-"))
  dbUrl = `file:${join(tmpDir, "themes.db")}`
  process.env.DATABASE_URL = dbUrl
  process.env.THEME_DIR = join(tmpDir, "themes")
  process.env.AUTH_SECRET = "th-secret-0123456789abcdef01234567"
  process.env.REALTIME_TOKEN = "th-rt-token-0123456789abcdef"
  process.env.NODE_ENV = "test"

  execSync(`cd '${ROOT}' && DATABASE_URL='${dbUrl}' ./node_modules/.bin/prisma migrate deploy`, { stdio: "pipe" })
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  // Settings "main" (la app la crea en init/seed; aquí directamente)
  await db.settings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } })
})

afterAll(async () => {
  await db?.$disconnect().catch(() => {})
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

/** Importa el módulo store DESPUÉS de que el env esté listo. */
async function freshStore() {
  const mod = await import("@/lib/themes/store")
  return mod
}

function isThemeError(e: unknown): e is ThemeError {
  return e instanceof Error && "code" in (e as object)
}

describe("instalación aislada (§10.19/§10.20)", () => {
  it("instala un paquete válido en un directorio AISLADO con re-validación", async () => {
    const { installTheme, importThemePackage } = await freshStore()
    const parsed = await import("@/lib/themes/package").then((m) => m.parseVTheme(validVTheme(), "3.1.0"))
    const res = await installTheme(parsed)
    expect(res.themeId).toBe("test-theme")
    expect(res.dir).toMatch(/^t-[a-z0-9]+-[a-f0-9]{16}$/)

    // El dir existe con theme.json y está BAJO imported/ (aislamiento real)
    const themeDir = join(tmpDir, "themes", "imported", res.dir)
    expect(existsSync(join(themeDir, "theme.json"))).toBe(true)

    // La fila existe en DB
    const row = await db.theme.findUnique({ where: { themeId: "test-theme" } })
    expect(row?.name).toBe("Tema de Prueba")

    // id duplicado → id_conflict
    try {
      await importThemePackage(validVTheme(), "MiTema.vtheme", "3.1.0")
      throw new Error("DEBÍA RECHAZAR duplicado")
    } catch (e) {
      expect(isThemeError(e) && e.code === "id_conflict").toBe(true)
    }
  })

  it("paquete con assets: archivos escritos en assets/ del dir aislado", async () => {
    const { importThemePackage } = await freshStore()
    const png = makePng(640, 360)
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "theme-with-assets" })), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "bg.png" } })), "utf8") },
      { name: "assets/", data: Buffer.alloc(0) },
      { name: "assets/bg.png", data: png },
    ])
    const res = await importThemePackage(buf, "ConAssets.vtheme", "3.1.0")
    expect(res.assets).toBe(1)
    const p = join(tmpDir, "themes", "imported", res.dir, "assets", "bg.png")
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p).length).toBe(png.length)
  })

  it("importación con nombre de archivo que NO es .vtheme → bad_extension", async () => {
    const { importThemePackage } = await freshStore()
    try {
      await importThemePackage(validVTheme({ id: "otro-id" }), "tema.zip", "3.1.0")
      throw new Error("DEBÍA RECHAZAR extensión")
    } catch (e) {
      expect(isThemeError(e) && e.code === "bad_extension").toBe(true)
    }
  })
})

describe("listado (integrados + importados)", () => {
  it("lista Default/Classic/Neon integrados + importados con active flag", async () => {
    const { listThemes } = await freshStore()
    const themes = await listThemes()
    const ids = themes.map((t) => t.id)
    expect(ids).toContain("default")
    expect(ids).toContain("viewlba-classic")
    expect(ids).toContain("viewlba-neon")
    expect(ids).toContain("test-theme")
    // Default activo por defecto
    expect(themes.find((t) => t.id === "default")!.active).toBe(true)
    // Los integrados no pueden estar broken
    expect(themes.filter((t) => t.builtin).every((t) => !t.broken)).toBe(true)
  })
})

describe("activación (§15)", () => {
  it("activar un tema IMPORTADO: cambia activeThemeId + colores sincronizados", async () => {
    const { activateTheme } = await freshStore()
    const res = await activateTheme("test-theme")
    expect(res.themeId).toBe("test-theme")
    expect(res.revertedToDefault).toBe(false)

    const s = await db.settings.findUnique({ where: { id: "main" } })
    expect(s?.activeThemeId).toBe("test-theme")
    expect(s?.primaryColor).toBe("#123456") // paleta del spec aplicada
    expect(s?.bgColor).toBe("#000102")
  })

  it("activar tema INTEGRADO (classic) funciona", async () => {
    const { activateTheme } = await freshStore()
    const res = await activateTheme("viewlba-classic")
    expect(res.name).toBe("ViewLBA Classic")
    const s = await db.settings.findUnique({ where: { id: "main" } })
    expect(s?.activeThemeId).toBe("viewlba-classic")
    expect(s?.primaryColor).toBe("#d4af37")
  })

  it("activar tema inexistente → not_found", async () => {
    const { activateTheme } = await freshStore()
    try {
      await activateTheme("no-existe")
      throw new Error("DEBÍA RECHAZAR not_found")
    } catch (e) {
      expect(isThemeError(e) && e.code === "not_found").toBe(true)
    }
  })

  it("activar tema con theme.json CORRUPTO en disco → storage_error (no activa)", async () => {
    const { importThemePackage, activateTheme } = await freshStore()
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "corrupto" })), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
    ])
    const res = await importThemePackage(buf, "Corrupto.vtheme", "3.1.0")
    // Sabotear el archivo en disco (ataque directo al almacenamiento)
    writeFileSync(join(tmpDir, "themes", "imported", res.dir, "theme.json"), "{\"palette\":{\"primary\":\"red\"}}")
    try {
      await activateTheme("corrupto")
      throw new Error("DEBÍA RECHAZAR corrupto")
    } catch (e) {
      expect(isThemeError(e) && e.code === "storage_error").toBe(true)
    }
  })
})

describe("eliminación (§7/§14)", () => {
  it("eliminar un tema INTEGRADO → builtin_protected", async () => {
    const { deleteTheme } = await freshStore()
    for (const id of ["default", "viewlba-classic", "viewlba-neon"]) {
      try {
        await deleteTheme(id)
        throw new Error(`DEBÍA RECHAZAR borrado de ${id}`)
      } catch (e) {
        expect(isThemeError(e) && e.code === "builtin_protected").toBe(true)
      }
    }
  })

  it("eliminar el tema ACTIVO → vuelve a Default automáticamente", async () => {
    const { activateTheme, deleteTheme } = await freshStore()
    await activateTheme("test-theme")
    const res = await deleteTheme("test-theme")
    expect(res.revertedToDefault).toBe(true)

    const s = await db.settings.findUnique({ where: { id: "main" } })
    expect(s?.activeThemeId).toBe("default")
    expect(s?.primaryColor).toBe("#f5a623") // paleta del Default
    // El dir aislado fue eliminado
    const dirs = await db.theme.findMany()
    expect(dirs.find((d) => d.themeId === "test-theme")).toBeUndefined()
  })
})

describe("resolución para la TV (§14 fallback duro)", () => {
  it("resuelve el tema activo importado con su spec", async () => {
    const { importThemePackage, activateTheme, resolveActiveTheme } = await freshStore()
    const res = await importThemePackage(classicVTheme(), "Classic.vtheme", "3.1.0")
    await activateTheme(res.themeId)
    const t = await resolveActiveTheme()
    expect(t.id).toBe("test-classic-copy")
    expect(t.spec.palette.primary).toBe("#d4af37")
    expect(t.isDefault).toBe(false)
  })

  it("tema activo con fila BORRADA directamente en DB → Default sin crash", async () => {
    const { activateTheme, resolveActiveTheme } = await freshStore()
    await activateTheme("viewlba-neon")
    // Sabotaje: apuntar Settings a un id que no existe
    await db.settings.update({ where: { id: "main" }, data: { activeThemeId: "fantasma" } })
    const t = await resolveActiveTheme()
    expect(t.id).toBe("default")
    expect(t.isDefault).toBe(true)
    expect(t.spec.palette.primary).toBe("#f5a623")
  })

  it("tema activo con theme.json dañado en disco → Default (TV nunca se queda sin tema)", async () => {
    const { importThemePackage, activateTheme, resolveActiveTheme } = await freshStore()
    const res = await importThemePackage(
      writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "roto" })), "utf8") },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      ]),
      "Roto.vtheme",
      "3.1.0"
    )
    await activateTheme(res.themeId)
    writeFileSync(join(tmpDir, "themes", "imported", res.dir, "theme.json"), "NO ES JSON{{{")
    const t = await resolveActiveTheme()
    expect(t.id).toBe("default")
    expect(t.isDefault).toBe(true)
  })

  it("backgroundImage resuelta a URL pública /api/theme-assets/…", async () => {
    const { importThemePackage, activateTheme, resolveActiveTheme } = await freshStore()
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "con-fondo" })), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "bg.png" } })), "utf8") },
      { name: "assets/bg.png", data: makePng(1280, 720) },
    ])
    const res = await importThemePackage(buf, "Fondo.vtheme", "3.1.0")
    await activateTheme(res.themeId)
    const t = await resolveActiveTheme()
    expect(t.backgroundImageUrl).toBe(`/api/theme-assets/con-fondo/bg.png`)
  })
})

describe("servir assets (anti-traversal en la ruta pública)", () => {
  it("asset declarado se sirve con el content-type correcto", async () => {
    const { readThemeAsset } = await freshStore()
    const a = await readThemeAsset("con-fondo", "bg.png")
    expect(a).not.toBeNull()
    expect(a!.contentType).toBe("image/png")
    expect(a!.data.length).toBeGreaterThan(0)
  })

  it("nombres con traversal o charset inválido → null (sin leer disco)", async () => {
    const { readThemeAsset } = await freshStore()
    expect(await readThemeAsset("con-fondo", "../../secret.db")).toBeNull()
    expect(await readThemeAsset("con-fondo", "..")).toBeNull()
    expect(await readThemeAsset("con-fondo", "sub/bg.png")).toBeNull()
    expect(await readThemeAsset("con-fondo", "")).toBeNull()
    expect(await readThemeAsset("no-existe", "bg.png")).toBeNull()
  })

  it("asset NO declarado en la fila (archivo colado en disco) → null", async () => {
    const { readThemeAsset } = await freshStore()
    // Colar un archivo directamente en el dir del tema (ataque directo)
    const row = await db.theme.findUnique({ where: { themeId: "con-fondo" } })
    const colado = join(tmpDir, "themes", "imported", row!.dir, "assets", "colado.png")
    writeFileSync(colado, Buffer.from("archivo colado"))
    expect(await readThemeAsset("con-fondo", "colado.png")).toBeNull() // no está en el índice validado
  })
})

describe("purge post-restore (§19)", () => {
  it("purga temas con archivos ausentes/corruptos y conserva los válidos", async () => {
    const { importThemePackage, purgeInvalidThemes, listThemes } = await freshStore()
    // Tema válido
    await importThemePackage(
      writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "valido-post-restore" })), "utf8") },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      ]),
      "Valido.vtheme",
      "3.1.0"
    )
    // Tema cuyo dir desaparece (simula restore de DB de otro equipo)
    const huérfano = await importThemePackage(
      writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "huerfano" })), "utf8") },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      ]),
      "Huerfano.vtheme",
      "3.1.0"
    )
    rmSync(join(tmpDir, "themes", "imported", huérfano.dir), { recursive: true, force: true })
    // Tema con theme.json corrupto
    const corrupto2 = await importThemePackage(
      writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "corrupto2" })), "utf8") },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      ]),
      "Corrupto2.vtheme",
      "3.1.0"
    )
    writeFileSync(join(tmpDir, "themes", "imported", corrupto2.dir, "theme.json"), "{\"unknown\":1}")

    const purged = await purgeInvalidThemes()
    expect(purged).toContain("huerfano")
    expect(purged).toContain("corrupto2")
    expect(purged).not.toContain("valido-post-restore")

    const themes = await listThemes()
    expect(themes.find((t) => t.id === "valido-post-restore")).toBeTruthy()
    expect(themes.find((t) => t.id === "huerfano")).toBeUndefined()
  })
})

describe("listThemes marca temas rotos (visibles para el admin, no activables)", () => {
  it("tema con spec corrupto aparece con broken=true", async () => {
    const { importThemePackage, listThemes } = await freshStore()
    const res = await importThemePackage(
      writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest({ id: "marcado-roto" })), "utf8") },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      ]),
      "Marcado.vtheme",
      "3.1.0"
    )
    writeFileSync(join(tmpDir, "themes", "imported", res.dir, "theme.json"), "corrupto{{{")
    const themes = await listThemes()
    const broken = themes.find((t) => t.id === "marcado-roto")
    expect(broken?.broken).toBe(true)
  })
})
