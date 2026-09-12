/**
 * ViewLBA — Sistema de temas TV (v3.1) · Tipos, schema y límites.
 *
 * Un tema .vtheme es 100% DECLARATIVO: manifiesto + configuración visual +
 * assets (imágenes raster / fuentes web permitidas). NUNCA contiene código
 * ejecutable (ver docs/THEME_SECURITY.md — el motor renderiza, el paquete
 * solo describe).
 *
 * Principio anti-schema-desconocido (§24 de la misión): cualquier campo
 * fuera del schema EXACTO se RECHAZA. Nunca se interpreta un campo
 * desconocido.
 */

// ---------------------------------------------------------------------------
// Versión del formato
// ---------------------------------------------------------------------------

/** Versión del esquema .vtheme que esta versión de ViewLBA SABE interpretar. */
export const VTHEME_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// LÍMITES DE SEGURIDAD (§12 zip bomb / recursion / recursos)
// ---------------------------------------------------------------------------

export const THEME_LIMITS = {
  /** Tamaño máximo del archivo .vtheme comprimido en disco. */
  maxPackageBytes: 50 * 1024 * 1024, // 50 MB
  /** Tamaño máximo TOTAL descomprimido (corte en streaming: bomba → reject). */
  maxUncompressedBytes: 120 * 1024 * 1024, // 120 MB
  /** Número máximo de entradas del ZIP (archivos + directorios). */
  maxEntries: 200,
  /** Profundidad máxima de ruta dentro del paquete (assets/x = 2). */
  maxPathDepth: 4,
  /** Longitud máxima del nombre de una entrada. */
  maxEntryNameLength: 128,
  /** Tamaño máximo de manifest.json / theme.json. */
  maxJsonBytes: 64 * 1024,
  /** Tamaño máximo por asset (imagen/fuente). */
  maxAssetBytes: 8 * 1024 * 1024,
  /** Número máximo de assets. */
  maxAssets: 64,
  /** Dimensiones máximas de imagen (px). */
  maxImageDimension: 4096,
  /** Ratio de compresión sospechoso (bomba) para entradas grandes. */
  bombRatio: 500,
  /** Umbral (bytes comprimidos) a partir del cual se aplica bombRatio. */
  bombRatioMinCompressed: 64 * 1024,
  /** Longitudes de los campos de texto del manifest. */
  maxIdLength: 64,
  minIdLength: 3,
  maxNameLength: 80,
  maxAuthorLength: 80,
  maxDescriptionLength: 400,
} as const

// ---------------------------------------------------------------------------
// Manifest.json (§8)
// ---------------------------------------------------------------------------

export interface ThemeManifest {
  /** EXACTAMENTE VTHEME_SCHEMA_VERSION (1). Otra versión → rechazo. */
  schemaVersion: number
  /** Identificador del paquete: slug [a-z0-9-]{3,64}. */
  id: string
  /** Nombre legible. */
  name: string
  /** Autor. */
  author: string
  /** Versión semántica del paquete (X.Y.Z). */
  version: string
  /** Descripción corta. */
  description: string
  /** Semver mínimo de ViewLBA compatible (comparación por componentes). */
  minViewLbaVersion: string
  /** Nivel de licencia requerido. Solo "full" (trial NO puede importar). */
  licenseTier: "full"
}

// ---------------------------------------------------------------------------
// theme.json — declaración visual (todos los campos OPCIONALES con default
// del tema Default; unknown keys = rechazo)
// ---------------------------------------------------------------------------

/** Paleta base (hex #RRGGBB — se valida con regex estricta). */
export interface ThemePalette {
  primary: string
  accent: string
  bg: string
  surface: string
}

/** Tipografías del MOTOR (lista blanca — nunca fuentes arbitrarias). */
export type ThemeFontKey = "display" | "serif" | "sans" | "mono"
export const THEME_FONT_WHITELIST: readonly ThemeFontKey[] = ["display", "serif", "sans", "mono"]

/** Estilos de reloj implementados por el motor. */
export type ThemeClockStyle = "classic" | "digital" | "neon"
export const THEME_CLOCK_STYLES: readonly ThemeClockStyle[] = ["classic", "digital", "neon"]

/** Estilos de ticker implementados por el motor. */
export type ThemeTickerStyle = "classic" | "neon"
export const THEME_TICKER_STYLES: readonly ThemeTickerStyle[] = ["classic", "neon"]

/** Transiciones del carrusel implementadas por el motor. */
export type ThemeCarouselTransition = "fade" | "slide" | "zoom"
export const THEME_CAROUSEL_TRANSITIONS: readonly ThemeCarouselTransition[] = ["fade", "slide", "zoom"]

/** Fondos decorativos declarativos (renderizados por el motor). */
export type ThemeBackgroundEffect = "none" | "gradient" | "grid" | "glow"
export const THEME_BACKGROUND_EFFECTS: readonly ThemeBackgroundEffect[] = ["none", "gradient", "grid", "glow"]

/** Sombra de tarjetas (motor). */
export type ThemeCardShadow = "none" | "soft" | "glow"
export const THEME_CARD_SHADOWS: readonly ThemeCardShadow[] = ["none", "soft", "glow"]

/** Interfaz STRICTA de theme.json (unknown → rechazo). */
export interface ThemeSpec {
  palette: ThemePalette
  typography: { heading: ThemeFontKey; body: ThemeFontKey }
  clock: { style: ThemeClockStyle }
  ticker: { style: ThemeTickerStyle }
  carousel: { transition: ThemeCarouselTransition }
  background: { effect: ThemeBackgroundEffect }
  cards: { radius: number; shadow: ThemeCardShadow }
  /** Referencias a assets del paquete (validadas contra el índice real). */
  assets: { backgroundImage: string | null }
}

/** theme.json tal como viene (parcial): los defaults los pone el merge. */
export type ThemeSpecInput = RecursivePartial<ThemeSpec>

export type RecursivePartial<T> = {
  [K in keyof T]?: T[K] extends object | null ? (T[K] extends null ? T[K] : RecursivePartial<T[K]>) : T[K]
}

// ---------------------------------------------------------------------------
// Assets permitidos (§9: sin código — solo datos renderizables)
// ---------------------------------------------------------------------------

/** Extensiones de asset PERMITIDAS (todo lo demás → rechazo). */
export const THEME_ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "woff2", "woff"] as const
export type ThemeAssetExtension = (typeof THEME_ASSET_EXTENSIONS)[number]

/** Extensiones PROHIBIDAS explícitas (mensaje claro de seguridad). */
export const THEME_FORBIDDEN_EXTENSIONS = [
  "js", "mjs", "cjs", "ts", "jsx", "tsx", // código
  "sh", "bash", "zsh", "bat", "cmd", "ps1", "psm1", "vbs", // shell
  "exe", "dll", "so", "dylib", "com", "jar", "class", "bin", "msi", "apk", "deb", "rpm", // binarios
  "py", "rb", "php", "pl", "lua", // scripts
  "html", "htm", "xhtml", "svg", "xml", // markup ejecutable/same-origin
  "css", // el CSS lo genera el motor desde valores validados
  "ttf", "otf", "eot", // formatos de fuente con superficie mayor (solo woff/woff2)
] as const

export interface ThemeAsset {
  /** Nombre de archivo DENTRO de assets/ (un solo nivel, saneado). */
  name: string
  extension: ThemeAssetExtension
  bytes: number
  /** Dimensiones para imágenes (null para fuentes). */
  width: number | null
  height: number | null
}

// ---------------------------------------------------------------------------
// Tema resuelto (lo que ve la TV — cero rutas internas)
// ---------------------------------------------------------------------------

/** Tema público para /api/content (SIN rutas del sistema). */
export interface PublicTheme {
  id: string
  name: string
  version: string
  /** Especificación visual interpretada por el motor de la TV. */
  spec: ThemeSpec
  /** URL pública de la imagen de fondo (null = sin imagen). */
  backgroundImageUrl: string | null
  /** true si el tema es el integrado Default (fallback garantizado). */
  isDefault: boolean
}

// ---------------------------------------------------------------------------
// Errores tipados (nunca exponen rutas internas)
// ---------------------------------------------------------------------------

export type ThemeRejectCode =
  | "bad_extension"      // no es .vtheme
  | "not_zip"            // cabecera/estructura ZIP inválida
  | "zip_corrupt"        // EOCD/central directory roto
  | "too_big"            // paquete > 50 MB
  | "too_many_entries"   // > 200 entradas
  | "entry_name_invalid" // ruta con ../, absoluta, \, NUL, control, etc.
  | "traversal"          // ../ o ruta absoluta explícita
  | "symlink"            // entrada no regular (symlink/dispositivo)
  | "encrypted_entry"    // entrada cifrada
  | "bad_compression"    // método de compresión no soportado
  | "bomb_suspected"     // ratio de compresión imposible
  | "uncompressed_limit" // total descomprimido > 120 MB (corte en streaming)
  | "asset_limit"        // > 64 assets o asset > 8 MB
  | "forbidden_file"     // extensión ejecutable/prohibida
  | "unknown_file"       // archivo fuera de manifest/theme/assets
  | "missing_manifest"   // no hay manifest.json
  | "missing_theme"      // no hay theme.json
  | "bad_json"           // JSON malformado / no objeto
  | "json_too_big"       // manifest/theme.json > 64 KB
  | "bad_schema"         // schemaVersion ≠ 1
  | "bad_field"          // campo inválido (tipo/formato/longitud)
  | "unknown_field"      // campo fuera del schema (§24)
  | "incompatible"       // minViewLbaVersion > versión actual
  | "wrong_tier"         // licenseTier ≠ full
  | "bad_asset_ref"      // theme.json referencia un asset inexistente
  | "bad_image"          // imagen corrupta/dimensiones excesivas
  | "duplicate"          // nombre o id duplicado
  | "id_conflict"        // ya existe un tema instalado con ese id
  | "not_found"          // tema inexistente
  | "builtin_protected"  // operación no permitida sobre tema integrado
  | "license_required"   // requiere licencia completa
  | "storage_error"      // error de E/S

export class ThemeError extends Error {
  constructor(
    public readonly code: ThemeRejectCode,
    message: string
  ) {
    super(message)
    this.name = "ThemeError"
  }
}
