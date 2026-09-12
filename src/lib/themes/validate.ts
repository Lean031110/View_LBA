/**
 * ViewLBA — Validadores de schema de .vtheme (manifest.json + theme.json).
 *
 * Estrictos y TIPADOS a mano (sin zod en runtime del tema: mensajes
 * controlados y cero sorpresas de coerción):
 *  · campo desconocido → unknown_field (§24: NUNCA interpretar schemas
 *    desconocidos)
 *  · tipo incorrecto → bad_field
 *  · rangos/regex → bad_field
 *  · semver por componentes → incompatible si minViewLbaVersion > actual
 *
 * La función devuelve un ThemeManifest/ThemeSpecInput VALIDADO o lanza
 * ThemeError con código tipado (fail-closed en TODO).
 */
import {
  THEME_LIMITS,
  THEME_FONT_WHITELIST,
  THEME_CLOCK_STYLES,
  THEME_TICKER_STYLES,
  THEME_CAROUSEL_TRANSITIONS,
  THEME_BACKGROUND_EFFECTS,
  THEME_CARD_SHADOWS,
  ThemeError,
  type ThemeManifest,
  type ThemeSpecInput,
  type ThemeFontKey,
  type ThemeClockStyle,
  type ThemeTickerStyle,
  type ThemeCarouselTransition,
  type ThemeBackgroundEffect,
  type ThemeCardShadow,
  type ThemeRejectCode,
} from "./types"

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/

function fail(code: ThemeRejectCode, msg: string): never {
  throw new ThemeError(code, msg)
}

function requireStringMap(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail("unknown_field", `Campo no reconocido en ${where}: '${k}'`)
  }
}

function str(v: unknown): string {
  if (typeof v !== "string") fail("bad_field", "Se esperaba texto")
  return v
}

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail("bad_field", "Se esperaba un número finito")
  return v
}

function bool(v: unknown): boolean {
  if (typeof v !== "boolean") fail("bad_field", "Se esperaba true/false")
  return v
}

function enumOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  const s = str(v)
  if (!(allowed as readonly string[]).includes(s)) {
    fail("bad_field", `Valor '${s}' no permitido en ${field} (permitidos: ${allowed.join(", ")})`)
  }
  return s as T
}

function checkHex(v: unknown, field: string): string {
  const s = str(v)
  if (!HEX_COLOR_RE.test(s)) fail("bad_field", `${field} debe ser un color hexadecimal #RRGGBB`)
  return s.toLowerCase()
}

/** Compara semver por componentes: a < b? (solo X.Y.Z — sin sufijos). */
export function semverLessThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  }
  return false
}

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

const MANIFEST_FIELDS = ["schemaVersion", "id", "name", "author", "version", "description", "minViewLbaVersion", "licenseTier"] as const

/**
 * Valida el objeto manifest.json (ya parseado). `viewlbaVersion` es la
 * versión ACTUAL del servidor (para minViewLbaVersion).
 */
export function validateManifest(raw: unknown, viewlbaVersion: string): ThemeManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("bad_json", "manifest.json debe ser un objeto JSON")
  }
  const obj = raw as Record<string, unknown>
  requireStringMap(obj, [...MANIFEST_FIELDS], "manifest.json")

  const schemaVersion = num(obj.schemaVersion)
  if (!Number.isInteger(schemaVersion)) fail("bad_schema", "schemaVersion debe ser entero")
  if (schemaVersion !== 1) fail("bad_schema", `schemaVersion ${schemaVersion} no soportado (este ViewLBA interpreta 1)`)

  const id = str(obj.id)
  if (!THEME_ID_RE.test(id) || id.length > THEME_LIMITS.maxIdLength) {
    fail("bad_field", "id debe ser un slug [a-z0-9-] de 3 a 64 caracteres")
  }

  const name = str(obj.name)
  if (name.trim().length < 1 || name.length > THEME_LIMITS.maxNameLength) {
    fail("bad_field", `name debe tener entre 1 y ${THEME_LIMITS.maxNameLength} caracteres`)
  }

  const author = str(obj.author)
  if (author.length > THEME_LIMITS.maxAuthorLength) fail("bad_field", `author demasiado largo (máx. ${THEME_LIMITS.maxAuthorLength})`)

  const version = str(obj.version)
  if (!SEMVER_RE.test(version)) fail("bad_field", "version debe ser semántica X.Y.Z (sin sufijos)")

  const description = str(obj.description)
  if (description.length > THEME_LIMITS.maxDescriptionLength) {
    fail("bad_field", `description demasiado larga (máx. ${THEME_LIMITS.maxDescriptionLength})`)
  }

  const minViewLbaVersion = str(obj.minViewLbaVersion)
  if (!SEMVER_RE.test(minViewLbaVersion)) fail("bad_field", "minViewLbaVersion debe ser X.Y.Z")
  if (semverLessThan(viewlbaVersion, minViewLbaVersion)) {
    fail("incompatible", `El tema requiere ViewLBA ≥ ${minViewLbaVersion} (instalado: ${viewlbaVersion})`)
  }

  const tier = str(obj.licenseTier)
  if (tier !== "full") fail("wrong_tier", "licenseTier debe ser 'full'")

  return { schemaVersion, id, name, author, version, description, minViewLbaVersion, licenseTier: "full" }
}

// ---------------------------------------------------------------------------
// theme.json
// ---------------------------------------------------------------------------

const SPEC_FIELDS = ["palette", "typography", "clock", "ticker", "carousel", "background", "cards", "assets"] as const
const PALETTE_FIELDS = ["primary", "accent", "bg", "surface"] as const
const TYPOGRAPHY_FIELDS = ["heading", "body"] as const
const CLOCK_FIELDS = ["style"] as const
const TICKER_FIELDS = ["style"] as const
const CAROUSEL_FIELDS = ["transition"] as const
const BACKGROUND_FIELDS = ["effect"] as const
const CARDS_FIELDS = ["radius", "shadow"] as const
const ASSETS_FIELDS = ["backgroundImage"] as const

/** Valida theme.json → ThemeSpecInput (parcial, solo campos presentes). */
export function validateThemeSpec(raw: unknown): ThemeSpecInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("bad_json", "theme.json debe ser un objeto JSON")
  }
  const obj = raw as Record<string, unknown>
  requireStringMap(obj, [...SPEC_FIELDS], "theme.json")

  const out: Record<string, Record<string, unknown>> = {}

  if ("palette" in obj) {
    const p = obj.palette
    if (p === null || typeof p !== "object" || Array.isArray(p)) fail("bad_field", "palette debe ser objeto")
    const po = p as Record<string, unknown>
    requireStringMap(po, [...PALETTE_FIELDS], "palette")
    const pal: Record<string, string> = {}
    for (const k of PALETTE_FIELDS) {
      if (k in po) pal[k] = checkHex(po[k], `palette.${k}`)
    }
    out.palette = pal
  }

  if ("typography" in obj) {
    const t = obj.typography
    if (t === null || typeof t !== "object" || Array.isArray(t)) fail("bad_field", "typography debe ser objeto")
    const to = t as Record<string, unknown>
    requireStringMap(to, [...TYPOGRAPHY_FIELDS], "typography")
    const ty: Record<string, ThemeFontKey> = {}
    if ("heading" in to) ty.heading = enumOf(to.heading, THEME_FONT_WHITELIST, "typography.heading")
    if ("body" in to) ty.body = enumOf(to.body, THEME_FONT_WHITELIST, "typography.body")
    out.typography = ty
  }

  if ("clock" in obj) {
    const c = obj.clock
    if (c === null || typeof c !== "object" || Array.isArray(c)) fail("bad_field", "clock debe ser objeto")
    const co = c as Record<string, unknown>
    requireStringMap(co, [...CLOCK_FIELDS], "clock")
    const cl: Record<string, ThemeClockStyle> = {}
    if ("style" in co) cl.style = enumOf(co.style, THEME_CLOCK_STYLES, "clock.style")
    out.clock = cl
  }

  if ("ticker" in obj) {
    const t = obj.ticker
    if (t === null || typeof t !== "object" || Array.isArray(t)) fail("bad_field", "ticker debe ser objeto")
    const to = t as Record<string, unknown>
    requireStringMap(to, [...TICKER_FIELDS], "ticker")
    const ti: Record<string, ThemeTickerStyle> = {}
    if ("style" in to) ti.style = enumOf(to.style, THEME_TICKER_STYLES, "ticker.style")
    out.ticker = ti
  }

  if ("carousel" in obj) {
    const c = obj.carousel
    if (c === null || typeof c !== "object" || Array.isArray(c)) fail("bad_field", "carousel debe ser objeto")
    const co = c as Record<string, unknown>
    requireStringMap(co, [...CAROUSEL_FIELDS], "carousel")
    const ca: Record<string, ThemeCarouselTransition> = {}
    if ("transition" in co) ca.transition = enumOf(co.transition, THEME_CAROUSEL_TRANSITIONS, "carousel.transition")
    out.carousel = ca
  }

  if ("background" in obj) {
    const b = obj.background
    if (b === null || typeof b !== "object" || Array.isArray(b)) fail("bad_field", "background debe ser objeto")
    const bo = b as Record<string, unknown>
    requireStringMap(bo, [...BACKGROUND_FIELDS], "background")
    const bg: Record<string, ThemeBackgroundEffect> = {}
    if ("effect" in bo) bg.effect = enumOf(bo.effect, THEME_BACKGROUND_EFFECTS, "background.effect")
    out.background = bg
  }

  if ("cards" in obj) {
    const c = obj.cards
    if (c === null || typeof c !== "object" || Array.isArray(c)) fail("bad_field", "cards debe ser objeto")
    const co = c as Record<string, unknown>
    requireStringMap(co, [...CARDS_FIELDS], "cards")
    const ca: Record<string, unknown> = {}
    if ("radius" in co) {
      const r = num(co.radius)
      if (!Number.isInteger(r) || r < 0 || r > 32) fail("bad_field", "cards.radius debe ser entero 0–32")
      ca.radius = r
    }
    if ("shadow" in co) ca.shadow = enumOf(co.shadow, THEME_CARD_SHADOWS, "cards.shadow")
    out.cards = ca
  }

  if ("assets" in obj) {
    const a = obj.assets
    if (a === null || typeof a !== "object" || Array.isArray(a)) fail("bad_field", "assets debe ser objeto")
    const ao = a as Record<string, unknown>
    requireStringMap(ao, [...ASSETS_FIELDS], "assets")
    const as: Record<string, unknown> = {}
    if ("backgroundImage" in ao) {
      if (ao.backgroundImage === null) {
        as.backgroundImage = null
      } else {
        const ref = str(ao.backgroundImage)
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(ref)) {
          fail("bad_asset_ref", "assets.backgroundImage debe ser un nombre de archivo dentro de assets/")
        }
        as.backgroundImage = ref
      }
    }
    out.assets = as
  }

  return out as unknown as ThemeSpecInput
}

/** ¿El booleano del merge? (uso interno del importador) */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
