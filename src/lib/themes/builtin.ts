/**
 * ViewLBA — Temas OFICIALES integrados (v3.1).
 *
 * Los tres viven EN CÓDIGO (no dependen de archivos externos — §14):
 *  · default : tema integrado de fábrica; SIEMPRE funciona; no se puede
 *              eliminar; es el fallback automático de todo el sistema.
 *  · classic : "ViewLBA Classic" — elegante, oscuro, profesional (§13).
 *  · neon    : "ViewLBA Neon" — moderno, tecnológico, brillos y
 *              animaciones suaves (§13).
 *
 * Classic y Neon se exportan además como paquetes .vtheme oficiales
 * (themes/ViewLBA-Classic.vtheme, themes/ViewLBA-Neon.vtheme — generados
 * por scripts/build-vtheme.ts) para probar el flujo REAL de importación.
 */
import type { ThemeManifest, ThemeSpec } from "./types"

/** Marca de tema integrado (no está en la DB; no se importa ni se borra). */
export const BUILTIN_SOURCE = "builtin" as const

export interface BuiltinTheme {
  manifest: ThemeManifest
  spec: ThemeSpec
  builtin: true
}

/** Spec completo del tema Default (valores base de todo merge). */
export const DEFAULT_SPEC: ThemeSpec = {
  palette: { primary: "#f5a623", accent: "#e8452c", bg: "#0b0b0f", surface: "#15151b" },
  typography: { heading: "display", body: "sans" },
  clock: { style: "classic" },
  ticker: { style: "classic" },
  carousel: { transition: "slide" },
  background: { effect: "none" },
  cards: { radius: 12, shadow: "soft" },
  assets: { backgroundImage: null },
}

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    manifest: {
      schemaVersion: 1,
      id: "default",
      name: "ViewLBA Default",
      author: "ViewLBA",
      version: "1.0.0",
      description: "Tema integrado de fábrica. Siempre disponible; no depende de archivos externos.",
      minViewLbaVersion: "3.1.0",
      licenseTier: "full",
    },
    spec: DEFAULT_SPEC,
    builtin: true,
  },
  {
    manifest: {
      schemaVersion: 1,
      id: "viewlba-classic",
      name: "ViewLBA Classic",
      author: "ViewLBA",
      version: "1.0.0",
      description: "Elegante, oscuro y profesional: oro cálido sobre negro profundo, reloj clásico y tarjetas suaves para restaurantes.",
      minViewLbaVersion: "3.1.0",
      licenseTier: "full",
    },
    spec: {
      palette: { primary: "#d4af37", accent: "#a32638", bg: "#0f0c07", surface: "#1a150c" },
      typography: { heading: "serif", body: "sans" },
      clock: { style: "classic" },
      ticker: { style: "classic" },
      carousel: { transition: "fade" },
      background: { effect: "gradient" },
      cards: { radius: 14, shadow: "soft" },
      assets: { backgroundImage: null },
    },
    builtin: true,
  },
  {
    manifest: {
      schemaVersion: 1,
      id: "viewlba-neon",
      name: "ViewLBA Neon",
      author: "ViewLBA",
      version: "1.0.0",
      description: "Moderno y tecnológico: cian y magenta con brillos, reloj digital, ticker neón y transiciones suaves.",
      minViewLbaVersion: "3.1.0",
      licenseTier: "full",
    },
    spec: {
      palette: { primary: "#00e5ff", accent: "#ff2d95", bg: "#05060e", surface: "#0d1024" },
      typography: { heading: "display", body: "sans" },
      clock: { style: "neon" },
      ticker: { style: "neon" },
      carousel: { transition: "zoom" },
      background: { effect: "glow" },
      cards: { radius: 6, shadow: "glow" },
      assets: { backgroundImage: null },
    },
    builtin: true,
  },
]

/** ¿themeId corresponde a un tema integrado? */
export function findBuiltin(themeId: string): BuiltinTheme | null {
  return BUILTIN_THEMES.find((t) => t.manifest.id === themeId) ?? null
}

/** IDs integrados (para proteger contra borrado/duplicado en importación). */
export const BUILTIN_THEME_IDS = BUILTIN_THEMES.map((t) => t.manifest.id)

/** Merge declarativo: input parcial sobre los defaults (el motor de la TV). */
export function mergeSpec(input: Partial<ThemeSpec> | null | undefined): ThemeSpec {
  const s = input ?? {}
  return {
    palette: { ...DEFAULT_SPEC.palette, ...(s.palette ?? {}) },
    typography: { ...DEFAULT_SPEC.typography, ...(s.typography ?? {}) },
    clock: { ...DEFAULT_SPEC.clock, ...(s.clock ?? {}) },
    ticker: { ...DEFAULT_SPEC.ticker, ...(s.ticker ?? {}) },
    carousel: { ...DEFAULT_SPEC.carousel, ...(s.carousel ?? {}) },
    background: { ...DEFAULT_SPEC.background, ...(s.background ?? {}) },
    cards: { ...DEFAULT_SPEC.cards, ...(s.cards ?? {}) },
    assets: { backgroundImage: s.assets?.backgroundImage ?? null },
  }
}
