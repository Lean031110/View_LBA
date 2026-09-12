/**
 * ViewLBA — Fachada del sistema de temas (v3.1).
 *
 * API interna:
 *   listThemes() · importThemePackage() · activateTheme() · deleteTheme()
 *   resolveActiveTheme() · readThemeAsset() · getThemesFeatureState()
 *
 * La versión de ViewLBA para minViewLbaVersion se lee de /VERSION (fuente
 * única de verdad del repo — en build standalone se embebe el valor).
 */
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Versión actual (cache leve; tests pueden pisar VIEWLBA_VERSION_FOR_THEMES)
// ---------------------------------------------------------------------------

let cachedVersion: string | null = null

/** Versión de ViewLBA para comprobación de compatibilidad de temas. */
export function viewlbaVersion(): string {
  if (process.env.VIEWLBA_VERSION_FOR_THEMES) return process.env.VIEWLBA_VERSION_FOR_THEMES
  if (cachedVersion) return cachedVersion
  try {
    // Dev/repo: /VERSION en la raíz. Producción standalone: junto al server.
    for (const p of [
      path.join(process.cwd(), "VERSION"),
      path.join(process.cwd(), "..", "VERSION"),
    ]) {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim()
        if (/^\d+\.\d+\.\d+/.test(v)) {
          cachedVersion = v
          return v
        }
      }
    }
  } catch {
    /* sin VERSION → default abajo */
  }
  cachedVersion = "3.1.0"
  return cachedVersion
}

export * from "./types"
export { BUILTIN_THEMES, BUILTIN_THEME_IDS, DEFAULT_SPEC, findBuiltin, mergeSpec } from "./builtin"
export { readZip, writeZip, crc32Of, validateEntryName } from "./zip"
export { validateManifest, validateThemeSpec, semverLessThan } from "./validate"
export { parseVTheme, buildVTheme, assertVThemeExtension } from "./package"
export {
  listThemes,
  importThemePackage,
  installTheme,
  activateTheme,
  deleteTheme,
  resolveActiveTheme,
  readThemeAsset,
  resolveThemeDir,
  countImportedThemes,
  listImportedDirs,
  type ThemeListItem,
  type InstallResult,
  type ActivateResult,
  type DeleteResult,
  type ThemeAssetFile,
} from "./store"
