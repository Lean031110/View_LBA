/**
 * ViewLBA — Pipeline de importación .vtheme (§10 de la misión: 21 pasos).
 *
 * El paquete NUNCA se extrae sobre directorios de producción: se valida en
 * memoria POR COMPLETO y solo si TODO pasa se instala en un directorio
 * AISLADO por tema. Fail-closed en cada paso; cualquier anomalía →
 * ThemeError tipado (REJECT SAFE, sin crash del servidor).
 *
 * Pasos (numeración de la misión):
 *  1 extensión .vtheme        12 tamaños de assets
 *  2 ZIP válido (EOCD/CD)     13 tipos de assets (magic bytes)
 *  3 tamaño máx. paquete      14 formatos (dimensiones imágenes)
 *  4 nº máx. de archivos      15 duplicados (nombres/id)
 *  5 profundidad de rutas     16 compatibilidad (minViewLbaVersion)
 *  6 path traversal ../       17 integridad (CRC32 por entrada)
 *  7 rutas absolutas          18 (firma: no aplica en v1 — documentado)
 *  8 symlinks/dispositivos    19 instalación en directorio aislado
 *  9 manifest presente+schema 20 revalidación post-instalación
 * 10 tipos de campos          21 (activación SOLO después de validar)
 * 11 assets declarados existen
 */
import { readZip, writeZip } from "./zip"
import { validateManifest, validateThemeSpec } from "./validate"
import { BUILTIN_THEME_IDS, DEFAULT_SPEC } from "./builtin"
import {
  THEME_LIMITS,
  THEME_ASSET_EXTENSIONS,
  ThemeError,
  type ThemeManifest,
  type ThemeSpecInput,
  type ThemeAsset,
  type ThemeAssetExtension,
} from "./types"

// ---------------------------------------------------------------------------
// Resultado del parseo (antes de persistir nada)
// ---------------------------------------------------------------------------

export interface ParsedVTheme {
  manifest: ThemeManifest
  /** theme.json validado (parcial — el merge ocurre al resolver). */
  specInput: ThemeSpecInput
  /** Assets validados con su contenido (buffers en memoria, ya limitados). */
  assets: ThemeAssetBuffer[]
}

export interface ThemeAssetBuffer {
  name: string
  extension: ThemeAssetExtension
  data: Buffer
  width: number | null
  height: number | null
}

// ---------------------------------------------------------------------------
// Imágenes: magic bytes + dimensiones (png/jpg/webp)
// ---------------------------------------------------------------------------

/** Detecta el tipo REAL de una imagen por magic bytes. */
function detectImageType(buf: Buffer): "png" | "jpeg" | "webp" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp"
  return null
}

/** Dimensiones PNG (IHDR) — null si no se puede leer. */
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // 8 firma + 4 len + 4 "IHDR" + 4 w + 4 h
  if (buf.length < 24) return null
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** Dimensiones JPEG (escaneo de marcadores SOF). */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let p = 2
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) return null
    const marker = buf[p + 1]
    // SOF0..SOF15 (excepto DHT/JPG/DAC temporales C4, C8, CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) }
    }
    const len = buf.readUInt16BE(p + 2)
    if (len < 2) return null
    p += 2 + len
  }
  return null
}

/** Dimensiones WebP (VP8X/VP8L/VP8). */
function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  const chunk = buf.toString("ascii", 12, 16)
  if (chunk === "VP8X") {
    if (buf.length < 30) return null
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)) // -1 canónico
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return { width: w, height: h }
  }
  if (chunk === "VP8 ") {
    if (buf.length < 30) return null
    // 20 bytes de cabecera del frame VP8 → 14: 3 bits + width(14), 16: height(14)
    const w = buf.readUInt16LE(26) & 0x3fff
    const h = buf.readUInt16LE(28) & 0x3fff
    return { width: w, height: h }
  }
  if (chunk === "VP8L") {
    if (buf.length < 21) return null
    // 12 RIFF/WEBP + 4 "VP8L" + 1 firma 0x2f → bits en el offset 17:
    // width-1 (14 bits) | height-1 (14 bits << 14)
    const b = buf.readUInt32LE(17)
    const w = (b & 0x3fff) + 1
    const h = ((b >> 14) & 0x3fff) + 1
    return { width: w, height: h }
  }
  return null
}

/** Fuentes Web: woff (wOFF) / woff2 (wOF2). */
function isWebFont(buf: Buffer): "woff" | "woff2" | null {
  if (buf.length >= 4) {
    const magic = buf.toString("ascii", 0, 4)
    if (magic === "wOFF") return "woff"
    if (magic === "wOF2") return "woff2"
  }
  return null
}

// ---------------------------------------------------------------------------
// Paso 18: extensión → tipo real COHERENTE (anti MIME falso / ext. falsa)
// ---------------------------------------------------------------------------

/** Estructura PNG ÍNTEGRA: cadena de chunks IHDR…→IEND con longitudes coherentes
 *  (detecta PNG truncados sin recorrer los píxeles). */
function pngStructureOk(buf: Buffer): boolean {
  let p = 8
  let sawIend = false
  let guard = 0
  while (p + 8 <= buf.length && guard < 256) {
    guard++
    const len = buf.readUInt32BE(p)
    const type = buf.toString("ascii", p + 4, p + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (len > buf.length - p - 12) return false // el chunk no cabe
    p += 8 + len + 4 // datos + CRC
    if (type === "IEND") {
      sawIend = true
      break
    }
  }
  return sawIend
}

function validateAssetContent(name: string, ext: ThemeAssetExtension, data: Buffer): { width: number | null; height: number | null } {
  if (data.length === 0) throw new ThemeError("bad_image", `Asset vacío: ${name}`)
  if (data.length > THEME_LIMITS.maxAssetBytes) {
    throw new ThemeError("asset_limit", `Asset demasiado grande (máx. 8 MB): ${name}`)
  }

  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") {
    const detected = detectImageType(data)
    if (!detected) throw new ThemeError("bad_image", `Contenido no es una imagen real: ${name}`)
    // Coherencia extensión ↔ contenido real
    if (detected === "png" && ext !== "png") throw new ThemeError("bad_image", `Extensión .${ext} pero el contenido es PNG: ${name}`)
    if (detected === "jpeg" && ext !== "jpg" && ext !== "jpeg") throw new ThemeError("bad_image", `Extensión .${ext} pero el contenido es JPEG: ${name}`)
    if (detected === "webp" && ext !== "webp") throw new ThemeError("bad_image", `Extensión .${ext} pero el contenido es WebP: ${name}`)

    const dims =
      detected === "png" ? pngDimensions(data) : detected === "jpeg" ? jpegDimensions(data) : webpDimensions(data)
    if (!dims || dims.width <= 0 || dims.height <= 0) throw new ThemeError("bad_image", `Imagen ilegible o corrupta: ${name}`)
    if (dims.width > THEME_LIMITS.maxImageDimension || dims.height > THEME_LIMITS.maxImageDimension) {
      throw new ThemeError("bad_image", `Imagen excede ${THEME_LIMITS.maxImageDimension}×${THEME_LIMITS.maxImageDimension}: ${name}`)
    }
    // PNG truncado: cadena de chunks rota o sin IEND → corrupto
    if (detected === "png" && !pngStructureOk(data)) {
      throw new ThemeError("bad_image", `PNG truncado o corrupto: ${name}`)
    }
    return dims
  }

  // woff / woff2
  const font = isWebFont(data)
  if (!font) throw new ThemeError("bad_image", `Contenido no es una fuente Web válida: ${name}`)
  if (font !== ext) throw new ThemeError("bad_image", `Extensión .${ext} pero el contenido es ${font}: ${name}`)
  return { width: null, height: null }
}

// ---------------------------------------------------------------------------
// Pipeline completo (pasos 1–17 en memoria; 19–20 en store.ts)
// ---------------------------------------------------------------------------

/** Paso 1: extensión del archivo. */
export function assertVThemeExtension(filename: string): void {
  if (!filename.toLowerCase().endsWith(".vtheme")) {
    throw new ThemeError("bad_extension", "El archivo debe tener extensión .vtheme")
  }
}

/**
 * Parsea y valida COMPLETAMENTE un buffer .vtheme (pasos 2–17).
 * No toca disco: devuelve manifest + spec + assets en memoria.
 */
export function parseVTheme(buf: Buffer, viewlbaVersion: string): ParsedVTheme {
  // 3. Tamaño del paquete
  if (buf.length === 0) throw new ThemeError("not_zip", "Paquete vacío")
  if (buf.length > THEME_LIMITS.maxPackageBytes) throw new ThemeError("too_big", "Paquete demasiado grande (máx. 50 MB)")

  // 2. Estructura ZIP + 4/5/6/7/8 + 15 + 17 (el lector aplica TODAS las
  //    reglas estructurales: traversal, absolutas, \, symlinks, cifrado,
  //    duplicados, presupuesto de descompresión, CRC por entrada)
  const entries = readZip(buf)

  const files = entries.filter((e) => !e.isDirectory)
  const dirs = entries.filter((e) => e.isDirectory)

  // Directorios permitidos SOLO "assets/" (raíz plana)
  for (const d of dirs) {
    if (d.name !== "assets/") {
      throw new ThemeError("unknown_file", `Directorio no permitido en el paquete: ${d.name} (solo assets/)`)
    }
  }

  // Índice de archivos por nombre
  const byName = new Map<string, (typeof files)[number]>()
  for (const f of files) byName.set(f.name, f)

  // Estructura esperada: manifest.json + theme.json + assets/*
  let manifestEntry: (typeof files)[number] | undefined
  let themeEntry: (typeof files)[number] | undefined
  const assetEntries: { name: string; entry: (typeof files)[number] }[] = []
  let assetsDirPresent = dirs.some((d) => d.name === "assets/")

  for (const f of files) {
    if (f.name === "manifest.json") {
      manifestEntry = f
    } else if (f.name === "theme.json") {
      themeEntry = f
    } else if (f.name.startsWith("assets/")) {
      const assetName = f.name.slice("assets/".length)
      if (assetName.length === 0 || assetName.includes("/")) {
        throw new ThemeError("entry_name_invalid", `Asset fuera de estructura (un solo nivel): ${f.name}`)
      }
      assetEntries.push({ name: assetName, entry: f })
    } else {
      // 9 (estructura): archivo desconocido en la raíz → rechazo
      throw new ThemeError("unknown_file", `Archivo no permitido en el paquete: ${f.name} (solo manifest.json, theme.json, assets/)`)
    }
  }
  if (assetEntries.length > 0 && !assetsDirPresent) assetsDirPresent = true // entrada de dir es opcional en el formato

  // 9. manifest.json y theme.json OBLIGATORIOS
  if (!manifestEntry) throw new ThemeError("missing_manifest", "Falta manifest.json")
  if (!themeEntry) throw new ThemeError("missing_theme", "Falta theme.json")

  // 12. tamaños de JSON
  if (manifestEntry.uncompressedSize > THEME_LIMITS.maxJsonBytes) throw new ThemeError("json_too_big", "manifest.json demasiado grande (máx. 64 KB)")
  if (themeEntry.uncompressedSize > THEME_LIMITS.maxJsonBytes) throw new ThemeError("json_too_big", "theme.json demasiado grande (máx. 64 KB)")

  // ---- Parseo JSON (fail-closed) ----
  let manifestRaw: unknown
  let specRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestEntry.read().toString("utf8"))
  } catch {
    throw new ThemeError("bad_json", "manifest.json no es JSON válido")
  }
  try {
    specRaw = JSON.parse(themeEntry.read().toString("utf8"))
  } catch {
    throw new ThemeError("bad_json", "theme.json no es JSON válido")
  }

  // 9/10. Schema del manifest + 16. compatibilidad
  const manifest = validateManifest(manifestRaw, viewlbaVersion)
  // 15b. id duplicado contra integrados (no se puede pisar default/classic/neon)
  if (BUILTIN_THEME_IDS.includes(manifest.id)) {
    throw new ThemeError("id_conflict", `El id '${manifest.id}' está reservado para un tema integrado`)
  }

  // 10. Schema de theme.json (tipos, enums, unknown fields)
  const specInput = validateThemeSpec(specRaw)

  // 11/12/13/14. Assets: límites, tipos REALES, dimensiones
  if (assetEntries.length > THEME_LIMITS.maxAssets) {
    throw new ThemeError("asset_limit", `Demasiados assets (máx. ${THEME_LIMITS.maxAssets})`)
  }
  const assets: ThemeAssetBuffer[] = []
  const assetNames = new Set<string>()
  for (const { name, entry } of assetEntries) {
    if (assetNames.has(name)) throw new ThemeError("duplicate", `Asset duplicado: ${name}`)
    assetNames.add(name)

    const dot = name.lastIndexOf(".")
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
    if (!(THEME_ASSET_EXTENSIONS as readonly string[]).includes(ext)) {
      // Mensaje diferenciado para contenido EJECUTABLE/markup peligroso (§9/§20)
      const forbidden = [
        "js", "mjs", "cjs", "ts", "jsx", "tsx", // código
        "sh", "bash", "zsh", "bat", "cmd", "ps1", "psm1", "vbs", // shell
        "exe", "dll", "so", "dylib", "com", "jar", "class", "bin", "msi", "apk", "deb", "rpm", // binarios
        "py", "rb", "php", "pl", "lua", // scripts
        "html", "htm", "xhtml", "svg", "xml", // markup ejecutable/same-origin
        "css", // el CSS lo genera el motor
        "ttf", "otf", "eot", // fuentes: solo woff/woff2
      ]
      if (forbidden.includes(ext)) {
        throw new ThemeError("forbidden_file", `Un tema NO puede contener código o markup ejecutable (.${ext}): ${name}`)
      }
      throw new ThemeError("unknown_file", `Tipo de asset no permitido (.${ext}): ${name}`)
    }

    const data = entry.read() // CRC + límites ya validados por el lector
    const dims = validateAssetContent(name, ext as ThemeAssetExtension, data)
    assets.push({ name, extension: ext as ThemeAssetExtension, data, width: dims.width, height: dims.height })
  }

  // 11b. Referencias de assets en theme.json DEBEN existir (§10.11)
  const bgRef = (specRaw as Record<string, unknown>)?.assets
  if (isRecord(bgRef)) {
    const ref = bgRef["backgroundImage"]
    if (typeof ref === "string" && !assetNames.has(ref)) {
      throw new ThemeError("bad_asset_ref", `theme.json referencia un asset inexistente: assets/${ref}`)
    }
    // La imagen de fondo debe ser IMAGEN (no fuente)
    if (typeof ref === "string") {
      const a = assets.find((x) => x.name === ref)
      if (a && (a.extension === "woff" || a.extension === "woff2")) {
        throw new ThemeError("bad_asset_ref", "backgroundImage debe ser una imagen (png/jpg/webp)")
      }
    }
  }

  return { manifest, specInput, assets }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Empaquetado .vtheme (oficial: genera los paquetes Classic/Neon del repo)
// ---------------------------------------------------------------------------

/** Construye un buffer .vtheme a partir de manifest+spec+assets. */
export function buildVTheme(manifest: ThemeManifest, spec: Partial<typeof DEFAULT_SPEC>, assets: { name: string; data: Buffer }[] = []): Buffer {
  const files: { name: string; data: Buffer }[] = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
    { name: "theme.json", data: Buffer.from(JSON.stringify(spec, null, 2) + "\n", "utf8") },
  ]
  if (assets.length > 0) {
    files.push({ name: "assets/", data: Buffer.alloc(0) }) // entrada de directorio
    for (const a of assets) files.push({ name: `assets/${a.name}`, data: a.data })
  }
  return writeZip(files)
}

/** Serializa un ThemeAsset[] (para la columna assetsJson de la DB). */
export function serializeAssets(assets: ThemeAssetBuffer[]): string {
  return JSON.stringify(
    assets.map((a) => ({ name: a.name, extension: a.extension, bytes: a.data.length, width: a.width, height: a.height }))
  )
}

export type { ThemeAsset }
