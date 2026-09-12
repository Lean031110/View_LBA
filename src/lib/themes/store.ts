/**
 * ViewLBA — Almacenamiento de temas: instalación aislada + activación.
 *
 * Layout en disco (NUNCA rutas absolutas del paquete — §10.19):
 *   <THEME_DIR>/imported/<dir>/theme.json   (spec validado)
 *   <THEME_DIR>/imported/<dir>/assets/<…>   (assets validados)
 *
 *   THEME_DIR por defecto: <cwd>/data/themes (config: THEME_DIR env).
 *
 * Reglas:
 *  · Instalar = validar TODO en memoria → crear dir con nombre generado
 *    por el servidor (nunca el id del paquete como ruta) → escribir →
 *    RE-VALIDAR desde disco (paso 20) → crear la fila en DB.
 *  · Eliminar tema integrado/default → builtin_protected.
 *  · Eliminar el tema ACTIVO → se vuelve a Default automáticamente
 *    (nunca deja la TV sin tema — §14).
 *  · Activar actualiza Settings.activeThemeId + colores heredados y
 *    emite broadcast content:update (§15 realtime) — la TV refetcha.
 */
import { mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import type { PrismaClient } from "@prisma/client"
import { db as defaultDb } from "@/lib/db"
import { broadcast } from "@/lib/realtime"
import { parseVTheme, serializeAssets, type ParsedVTheme } from "./package"
import { validateThemeSpec } from "./validate"
import { findBuiltin, BUILTIN_THEMES, DEFAULT_SPEC, mergeSpec } from "./builtin"
import { ThemeError, type ThemeManifest, type ThemeSpec, type PublicTheme } from "./types"

// ---------------------------------------------------------------------------
// Cliente de DB (singleton de la app; inyectable SOLO en tests)
// ---------------------------------------------------------------------------

let dbOverride: PrismaClient | null = null

/** Tests: sustituye el cliente Prisma del store (NUNCA usar en producción). */
export function __setThemeDbForTests(client: PrismaClient | null): void {
  dbOverride = client
}

/** Cliente activo para las operaciones de temas. */
function themesDb(): PrismaClient {
  return dbOverride ?? defaultDb
}

// ---------------------------------------------------------------------------
// Directorios
// ---------------------------------------------------------------------------

export function resolveThemeDir(): string {
  const configured = process.env.THEME_DIR?.trim()
  return configured ? path.resolve(configured) : path.join(process.cwd(), "data", "themes")
}

/** Subdirectorio aislado de los importados. */
function importedRoot(): string {
  return path.join(resolveThemeDir(), "imported")
}

/** Nombre de directorio GENERADO por el servidor (aislamiento total). */
function newDirName(): string {
  return `t-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`
}

// ---------------------------------------------------------------------------
// Resolución de specs (fila DB → ThemeSpec con fallback duro)
// ---------------------------------------------------------------------------

interface StoredTheme {
  id: string
  themeId: string
  name: string
  author: string
  version: string
  description: string
  manifestJson: string
  themeJson: string
  dir: string
  assetsJson: string
}

function parseStoredJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Lee y re-valida el spec de un tema IMPORTADO DESDE DISCO (paso 20).
 *  La DB NO es autoridad: el theme.json del dir aislado se re-parsea con el
 *  validador estricto en cada uso; archivo ausente/corrupto → null (el
 *  llamador cae a Default o marca broken). */
async function loadImportedSpec(row: StoredTheme): Promise<ThemeSpec | null> {
  try {
    const file = path.join(importedRoot(), row.dir, "theme.json")
    const raw = await readFile(file, "utf8").catch(() => null)
    if (raw === null) return null
    const specInput = JSON.parse(raw) as Record<string, unknown>
    const validated = validateThemeSpec(specInput)
    return mergeSpec(validated as never)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Instalación (pasos 19–20)
// ---------------------------------------------------------------------------

export interface InstallResult {
  themeId: string
  name: string
  version: string
  dir: string
  assets: number
}

/**
 * Instala un .vtheme ya PARSEADO (validado en memoria) en su directorio
 * aislado + fila en DB. Re-valida desde disco tras escribir (paso 20).
 */
export async function installTheme(parsed: ParsedVTheme): Promise<InstallResult> {
  const { manifest, specInput, assets } = parsed

  // Id único (id_conflict si ya está instalado o es integrado — parseVTheme
  // ya cubrió integrados; aquí cubrimos duplicados instalados)
  const existing = await themesDb().theme.findUnique({ where: { themeId: manifest.id } })
  if (existing) {
    throw new ThemeError("id_conflict", `Ya hay un tema instalado con el id '${manifest.id}' (elimínalo antes de reimportar)`)
  }

  const dir = newDirName()
  const themeDir = path.join(importedRoot(), dir)
  const assetsDir = path.join(themeDir, "assets")

  try {
    await mkdir(assetsDir, { recursive: true })
    await writeFile(path.join(themeDir, "theme.json"), JSON.stringify(specInput, null, 2), { mode: 0o644 })
    for (const a of assets) {
      // Nombre de asset YA validado (charset estricto, un nivel)
      await writeFile(path.join(assetsDir, a.name), a.data, { mode: 0o644 })
    }
  } catch {
    // Limpieza del dir a medias (sin dejar basura explotable)
    await rm(themeDir, { recursive: true, force: true }).catch(() => {})
    throw new ThemeError("storage_error", "No se pudo escribir el tema en el almacenamiento")
  }

  // Paso 20: re-validación desde disco — lo escrito ES lo validado
  const written = await readFile(path.join(themeDir, "theme.json"), "utf8").catch(() => {
    throw new ThemeError("storage_error", "Verificación post-instalación fallida (theme.json ilegible)")
  })
  try {
    validateThemeSpec(JSON.parse(written))
  } catch {
    await rm(themeDir, { recursive: true, force: true }).catch(() => {})
    throw new ThemeError("storage_error", "Verificación post-instalación fallida (theme.json corrupto)")
  }

  await themesDb().theme.create({
    data: {
      themeId: manifest.id,
      name: manifest.name,
      author: manifest.author,
      version: manifest.version,
      description: manifest.description,
      manifestJson: JSON.stringify(manifest),
      themeJson: JSON.stringify(specInput),
      dir,
      assetsJson: serializeAssets(assets),
      source: "imported",
    },
  })

  return { themeId: manifest.id, name: manifest.name, version: manifest.version, dir, assets: assets.length }
}

// ---------------------------------------------------------------------------
// Listado (integrados + importados)
// ---------------------------------------------------------------------------

export interface ThemeListItem {
  id: string // themeId del paquete (o "default")
  name: string
  author: string
  version: string
  description: string
  builtin: boolean
  installedAt: string | null
  active: boolean
  assets: { name: string; bytes: number; width: number | null; height: number | null }[]
  /** Muestra para la vista previa del manager (paleta + estilo). */
  spec: ThemeSpec
  /** true si el spec en disco está corrupto/dañado (solo importados). */
  broken: boolean
}

/** ¿Id de tema ACTIVO en Settings? */
async function activeThemeIdRaw(): Promise<string> {
  const s = await themesDb().settings.findUnique({ where: { id: "main" }, select: { activeThemeId: true } })
  return s?.activeThemeId ?? "default"
}

export async function listThemes(): Promise<ThemeListItem[]> {
  const active = await activeThemeIdRaw()
  const rows = (await themesDb().theme.findMany({ orderBy: { installedAt: "asc" } })) as unknown as StoredTheme[]

  const items: ThemeListItem[] = BUILTIN_THEMES.map((t) => ({
    id: t.manifest.id,
    name: t.manifest.name,
    author: t.manifest.author,
    version: t.manifest.version,
    description: t.manifest.description,
    builtin: true,
    installedAt: null,
    active: active === t.manifest.id,
    assets: [],
    spec: t.spec,
    broken: false,
  }))

  for (const r of rows) {
    const spec = await loadImportedSpec(r)
    items.push({
      id: r.themeId,
      name: r.name,
      author: r.author,
      version: r.version,
      description: r.description,
      builtin: false,
      installedAt: (r as { installedAt?: { toISOString?: () => string } }).installedAt?.toISOString?.() ?? null,
      active: active === r.themeId,
      assets: parseStoredJson<ThemeListItem["assets"]>(r.assetsJson, []),
      spec: spec ?? DEFAULT_SPEC,
      broken: spec === null,
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Activación (§15: broadcast realtime; §14: fallback a Default)
// ---------------------------------------------------------------------------

export interface ActivateResult {
  themeId: string
  name: string
  revertedToDefault: boolean
}

/**
 * Activa un tema (integrado o importado). Al activar un tema IMPORTADO se
 * re-valida su spec desde disco (paso 20 en cada activación — la DB nunca
 * es autoridad de la validez del contenido). Si el tema activo no existe
 * o su spec en disco está corrupto → ThemeError (no silent-fallback en
 * activación explícita; el fallback automático ocurre en resolución).
 */
export async function activateTheme(themeId: string): Promise<ActivateResult> {
  if (themeId === "default") {
    await applyThemeSettings("default", findBuiltin("default")!.spec)
    return { themeId: "default", name: "ViewLBA Default", revertedToDefault: true }
  }

  const builtin = findBuiltin(themeId)
  if (builtin) {
    await applyThemeSettings(builtin.manifest.id, builtin.spec)
    return { themeId: builtin.manifest.id, name: builtin.manifest.name, revertedToDefault: false }
  }

  const row = (await themesDb().theme.findUnique({ where: { themeId } })) as unknown as StoredTheme | null
  if (!row) throw new ThemeError("not_found", `No existe el tema '${themeId}'`)

  const spec = await loadImportedSpec(row)
  if (!spec) {
    // El spec en disco está corrupto/editado → NO se activa (defensa §10.20)
    throw new ThemeError("storage_error", "El tema instalado está dañado (theme.json inválido); no se activará. Vuelve a importarlo.")
  }

  await applyThemeSettings(row.themeId, spec)
  return { themeId: row.themeId, name: row.name, revertedToDefault: false }
}

/** Persiste el tema activo + colores del tema (compat visual ETag/TV). */
async function applyThemeSettings(themeId: string, spec: ThemeSpec): Promise<void> {
  await themesDb().settings.update({
    where: { id: "main" },
    data: {
      activeThemeId: themeId,
      primaryColor: spec.palette.primary,
      accentColor: spec.palette.accent,
      bgColor: spec.palette.bg,
      surfaceColor: spec.palette.surface,
    },
  })
  // §15 REALTIME: las TVs refetch /api/content al instante (mismo mecanismo
  // que settings — el ETag invalida por updatedAt de Settings + sello de Theme)
  await broadcast("content:update", { section: "settings", ts: Date.now() }, "screens")
}

// ---------------------------------------------------------------------------
// Eliminación
// ---------------------------------------------------------------------------

export interface DeleteResult {
  deletedThemeId: string
  revertedToDefault: boolean
}

export async function deleteTheme(themeId: string): Promise<DeleteResult> {
  // §7: el tema predeterminado NO se puede eliminar (tampoco integrados)
  if (findBuiltin(themeId)) {
    throw new ThemeError("builtin_protected", "Los temas integrados (Default/Classic/Neon) no se pueden eliminar")
  }
  const row = (await themesDb().theme.findUnique({ where: { themeId } })) as unknown as StoredTheme | null
  if (!row) throw new ThemeError("not_found", `No existe el tema '${themeId}'`)

  // Borrado del dir aislado (solo su propio dir — jamás fuera de imported/)
  const target = path.join(importedRoot(), row.dir)
  // Guarda dura: el path resuelto DEBE quedar dentro de importedRoot()
  if (!path.resolve(target).startsWith(path.resolve(importedRoot()) + path.sep)) {
    throw new ThemeError("storage_error", "Ruta interna de tema inválida (defensa anti-traversal)")
  }
  await rm(target, { recursive: true, force: true }).catch(() => {})

  await themesDb().theme.delete({ where: { id: row.id } })

  // Si era el activo → volver a Default automáticamente (§14)
  const active = await activeThemeIdRaw()
  let revertedToDefault = false
  if (active === themeId) {
    await applyThemeSettings("default", findBuiltin("default")!.spec)
    revertedToDefault = true
  }
  return { deletedThemeId: themeId, revertedToDefault }
}

// ---------------------------------------------------------------------------
// Resolución para /api/content (con fallback duro §14)
// ---------------------------------------------------------------------------

/**
 * Resuelve el tema PÚBLICO activo. Regla §14: si el tema activo falta, su
 * fila fue borrada o su spec en disco está corrupto → DEFAULT (la TV NUNCA
 * se queda sin tema). La caída es silenciosa y registrada por el llamador.
 */
export async function resolveActiveTheme(): Promise<PublicTheme> {
  const active = await activeThemeIdRaw()

  if (active === "default") {
    const d = findBuiltin("default")!
    return { id: "default", name: d.manifest.name, version: d.manifest.version, spec: d.spec, backgroundImageUrl: null, isDefault: true }
  }

  const builtin = findBuiltin(active)
  if (builtin) {
    return { id: builtin.manifest.id, name: builtin.manifest.name, version: builtin.manifest.version, spec: builtin.spec, backgroundImageUrl: null, isDefault: false }
  }

  const row = (await themesDb().theme.findUnique({ where: { themeId: active } })) as unknown as StoredTheme | null
  if (row) {
    const spec = await loadImportedSpec(row)
    if (spec) {
      const manifest = parseStoredJson<Partial<ThemeManifest>>(row.manifestJson, {})
      const bgRef = spec.assets.backgroundImage
      const backgroundImageUrl = bgRef ? `/api/theme-assets/${encodeURIComponent(row.themeId)}/${encodeURIComponent(bgRef)}` : null
      return {
        id: row.themeId,
        name: row.name,
        version: manifest.version ?? row.version,
        spec,
        backgroundImageUrl,
        isDefault: false,
      }
    }
  }

  // FALLO → Default (nunca sin tema)
  const d = findBuiltin("default")!
  return { id: "default", name: d.manifest.name, version: d.manifest.version, spec: d.spec, backgroundImageUrl: null, isDefault: true }
}

// ---------------------------------------------------------------------------
// Servir assets (ruta pública /api/theme-assets/[themeId]/[name])
// ---------------------------------------------------------------------------

export interface ThemeAssetFile {
  data: Buffer
  contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
}

/**
 * Lee un asset del tema themeId. El nombre SOLO puede ser [A-Za-z0-9._-]
 * (charset validado) y debe existir en la fila del tema (nunca readdir
 * ciego). Devuelve null si tema/asset no existen (la TV degrada sin crash).
 */
export async function readThemeAsset(themeId: string, assetName: string): Promise<ThemeAssetFile | null> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(assetName) || assetName.includes("..")) return null
  const row = (await themesDb().theme.findUnique({ where: { themeId } })) as unknown as StoredTheme | null
  if (!row) return null

  // El asset debe estar DECLARADO en la fila validada (índice de confianza)
  const declared = parseStoredJson<{ name: string; extension: string }[]>(row.assetsJson, [])
  const hit = declared.find((a) => a.name === assetName)
  if (!hit) return null

  const target = path.join(importedRoot(), row.dir, "assets", assetName)
  if (!path.resolve(target).startsWith(path.resolve(importedRoot()) + path.sep)) return null

  try {
    const data = await readFile(target)
    if (data.length > 8 * 1024 * 1024) return null
    return { data, contentType: CONTENT_TYPES[hit.extension] ?? "application/octet-stream" }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Importación completa (parse + install) — fachada para la ruta API
// ---------------------------------------------------------------------------

export async function importThemePackage(buf: Buffer, filename: string, viewlbaVersion: string): Promise<InstallResult> {
  // Paso 1 (extensión) + 2–17 (parse) + 19–20 (instalación aislada)
  if (!filename.toLowerCase().endsWith(".vtheme")) {
    throw new ThemeError("bad_extension", "El archivo debe tener extensión .vtheme")
  }
  const parsed = parseVTheme(buf, viewlbaVersion)
  return installTheme(parsed)
}

/** Conteo de importados (tests/telemetría). */
export async function countImportedThemes(): Promise<number> {
  return themesDb().theme.count()
}

/**
 * Post-restore (§19): revalida los temas instalados contra el disco ACTUAL
 * y PURGA las filas cuyo paquete ya no es válido (tema de otro equipo, disco
 * cambiado, archivos corruptos). Devuelve los ids purgados. La revalidación
 * JAMÁS ejecuta nada: solo re-parsea theme.json con el validador estricto.
 * Si el tema ACTIVO queda purgado, el sistema ya recae en Default (§14).
 */
export async function purgeInvalidThemes(): Promise<string[]> {
  const rows = (await themesDb().theme.findMany()) as unknown as StoredTheme[]
  const purged: string[] = []
  for (const r of rows) {
    const spec = await loadImportedSpec(r)
    if (spec === null) {
      // theme.json inválido/ausente en disco → fila obsoleta o corrupta
      await themesDb().theme.delete({ where: { id: r.id } }).catch(() => {})
      const target = path.join(importedRoot(), r.dir)
      await rm(target, { recursive: true, force: true }).catch(() => {})
      purged.push(r.themeId)
      continue
    }
    // Assets declarados deben existir (solo índice confiable)
    const declared = parseStoredJson<{ name: string }[]>(r.assetsJson, [])
    for (const a of declared) {
      const p = path.join(importedRoot(), r.dir, "assets", a.name)
      const okFile = await readFile(p)
        .then((b) => b.length > 0)
        .catch(() => false)
      if (!okFile) {
        await themesDb().theme.delete({ where: { id: r.id } }).catch(() => {})
        await rm(path.join(importedRoot(), r.dir), { recursive: true, force: true }).catch(() => {})
        purged.push(r.themeId)
        break
      }
    }
  }
  return purged
}

/** Lista los directorios de temas instalados (tests de aislamiento). */
export async function listImportedDirs(): Promise<string[]> {
  try {
    return await readdir(importedRoot())
  } catch {
    return []
  }
}
