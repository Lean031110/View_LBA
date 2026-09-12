/**
 * Helpers de tests de temas (tests/themes).
 *
 * Construye paquetes .vtheme válidos y MALICIOSOS en memoria usando el
 * escritor ZIP del propio motor (STORED determinista) o buffers raw para
 * ataques que necesitan estructura ZIP manual (symlinks, flags, ratios).
 * NUNCA toca el disco del repo — todo en tmpdir() cuando se requiere disco.
 */
import { writeZip, crc32Of } from "@/lib/themes/zip"
import { BUILTIN_THEMES } from "@/lib/themes/builtin"
import type { ThemeManifest, ThemeSpecInput } from "@/lib/themes/types"

/** Manifest válido canónico para tests. */
export function baseManifest(overrides: Partial<ThemeManifest> = {}): ThemeManifest {
  return {
    schemaVersion: 1,
    id: "test-theme",
    name: "Tema de Prueba",
    author: "QA ViewLBA",
    version: "1.2.3",
    description: "Tema sintético para tests automatizados.",
    minViewLbaVersion: "3.1.0",
    licenseTier: "full",
    ...overrides,
  }
}

/** theme.json válido (espec completo). */
export function baseSpec(overrides: ThemeSpecInput = {}): ThemeSpecInput {
  return {
    palette: { primary: "#123456", accent: "#abcdef", bg: "#000102", surface: "#0a0b0c" },
    typography: { heading: "serif", body: "sans" },
    clock: { style: "digital" },
    ticker: { style: "classic" },
    carousel: { transition: "fade" },
    background: { effect: "grid" },
    cards: { radius: 8, shadow: "glow" },
    assets: { backgroundImage: null },
    ...overrides,
  }
}

/** Paquete .vtheme VÁLIDO estándar (sin assets). */
export function validVTheme(manifestOverrides: Partial<ThemeManifest> = {}, specOverrides: ThemeSpecInput = {}): Buffer {
  return writeZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest(manifestOverrides)), "utf8") },
    { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec(specOverrides)), "utf8") },
  ])
}

/** El tema Classic integrado como paquete .vtheme (id copia para no chocar). */
export function classicVTheme(): Buffer {
  const t = BUILTIN_THEMES.find((b) => b.manifest.id === "viewlba-classic")!
  return writeZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ ...t.manifest, id: "test-classic-copy" }), "utf8") },
    { name: "theme.json", data: Buffer.from(JSON.stringify(t.spec), "utf8") },
  ])
}

// ---------------------------------------------------------------------------
// Imágenes sintéticas (magic bytes + cabeceras de dimensiones REALES)
// ---------------------------------------------------------------------------

/** PNG mínimo VÁLIDO de WxH (IHDR real + IDAT + IEND con CRCs correctos). */
export function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type RGBA
  const ihdr = Buffer.concat([Buffer.from("IHDR"), ihdrData])
  const ihdrChunk = Buffer.concat([len(13), ihdr, crc(ihdr)])

  const raw = Buffer.alloc(1 + Math.max(height, 1) * (1 + Math.max(width, 1) * 4))
  const idat = Buffer.concat([Buffer.from("IDAT"), raw])
  const idatChunk = Buffer.concat([len(raw.length), idat, crc(idat)])

  const iend = Buffer.from("IEND")
  const iendChunk = Buffer.concat([len(0), iend, crc(iend)])

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk])

  function len(n: number): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  function crc(data: Buffer): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(crc32Of(data), 0)
    return b
  }
}

/** PNG pequeño cuya IHDR DECLARA dimensiones arbitrarias (para tests de
 *  límites sin asignar cientos de MB de píxeles reales). */
export function makePngWithDims(width: number, height: number): Buffer {
  const png = makePng(8, 8)
  // IHDR empieza tras la firma (8) + len(4) + "IHDR"(4) → W en 16, H en 20
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  // Recalcular el CRC del IHDR (el resto de chunks queda intacto)
  const ihdr = png.subarray(12, 29) // "IHDR" + 13 bytes de datos
  const crc = crc32Of(ihdr)
  png.writeUInt32LE(crc, 29)
  return png
}

/** JPEG sintético mínimo con marcador SOF0 que declara WxH. */
export function makeJpeg(width: number, height: number): Buffer {
  // Estructura: FF D8 | FF C0 | len(2) | prec(1) | H(2) | W(2) | Nf(1)… | FF D9
  const sof = Buffer.alloc(17)
  sof[0] = 0xff
  sof[1] = 0xc0 // SOF0
  sof.writeUInt16BE(15, 2) // length
  sof[4] = 8 // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 1 // componentes
  sof[10] = 1
  sof[11] = 0x22
  sof[12] = 0
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

/** WebP sintético (contenedor VP8L) WxH. */
export function makeWebP(width: number, height: number): Buffer {
  const w = Math.min(width, 16383) - 1
  const h = Math.min(height, 16383) - 1
  const bits = (w & 0x3fff) | ((h & 0x3fff) << 14)
  const vp8l = Buffer.alloc(5)
  vp8l[0] = 0x2f // firma VP8L
  vp8l.writeUInt32LE(bits, 1)
  const body = Buffer.concat([Buffer.from("VP8L"), vp8l])
  const out = Buffer.alloc(12 + body.length)
  out.write("RIFF", 0, "ascii")
  out.writeUInt32LE(body.length, 4)
  out.write("WEBP", 8, "ascii")
  body.copy(out, 12)
  return out
}

/** woff2 sintético (magic wOF2). */
export function makeWoff2(): Buffer {
  const b = Buffer.alloc(64)
  b.write("wOF2", 0, "ascii")
  return b
}

/** woff sintético (magic wOFF). */
export function makeWoff(): Buffer {
  const b = Buffer.alloc(64)
  b.write("wOFF", 0, "ascii")
  return b
}

// ---------------------------------------------------------------------------
// ZIP MALICIOSO artesanal (estructura manual — el escritor legítimo no
// puede producir estos ataques)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v, 0)
  return b
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v, 0)
  return b
}

export interface EvilEntry {
  name: string
  data: Buffer
  /** Atributos externos (modos Unix en el byte alto). */
  externalAttrs?: number
  /** Flags (bit 0 = cifrado). */
  flags?: number
  /** Método (0 stored, 8 deflate). */
  method?: number
  /** Tamaño descomprimido para MENTIR en el central directory. */
  lieUncompressed?: number
  /** CRC32 declarado (por defecto el del contenido — se puede mentir). */
  lieCrc?: number
}

/** ZIP STORED artesanal con control total de los metadatos de cada entrada. */
export function writeEvilZip(entries: EvilEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8")
    const data = e.data
    const method = e.method ?? 0
    const flags = e.flags ?? 0
    const crc = e.lieCrc ?? crc32Of(data)
    const uncomp = e.lieUncompressed ?? data.length

    const loc = Buffer.concat([u32(LOC_SIG), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0)])
    locals.push(loc, nameBuf, data)

    const cen = Buffer.concat([
      u32(CEN_SIG),
      u16(0x031e), // made by: Unix (para que el modo Unix se respete)
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(data.length),
      u32(uncomp),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(e.externalAttrs ?? 0),
      u32(offset),
    ])
    centrals.push(cen, nameBuf)

    offset += loc.length + nameBuf.length + data.length
  }

  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.concat([u32(EOCD_SIG), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdBuf.length), u32(offset), u16(0)])
  return Buffer.concat([...locals, cdBuf, eocd])
}

/** Bytes uniformes (deflate los comprime ~1000× — base de bombas). */
export function zeros(len: number): Buffer {
  return Buffer.alloc(len)
}
