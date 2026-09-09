/**
 * Genera los íconos oficiales de la GUI (sin dependencias): PNG RGBA puro
 * (zlib de Node) + ICO con frames PNG. Diseño: gradiente azul→violeta con el
 * glifo de una pantalla TV (señalización digital).
 *
 * Salidas en installer/gui/src-tauri/icons/:
 *   icon.png (512) · 128x128.png · 128x128@2x.png (256) · 32x32.png · icon.ico
 */
import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../gui/src-tauri/icons")
mkdirSync(OUT, { recursive: true })

// ---------- PNG mínimo ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // scanlines con filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[y * (1 + width * 4) + 1 + i] = v
    })
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}

// ---------- diseño ----------
type RGBA = [number, number, number, number]

/** Gradiente + glifo TV con anti-aliasing por SDF. */
function pixel(x: number, y: number, size: number): RGBA {
  const u = x / size
  const v = y / size
  // fondo: gradiente diagonal 135°
  const t = Math.min(1, Math.max(0, (u + v) / 2))
  const bg: RGBA = [
    Math.round(0x2f + (0x7c - 0x2f) * t),
    Math.round(0x81 + (0x3a - 0x81) * t),
    Math.round(0xf7 + (0xed - 0xf7) * t),
    255,
  ]
  // esquinas redondeadas del icono (radio 22%)
  const corner = roundedRectSDF(u, v, 0.02, 0.02, 0.96, 0.96, 0.22)
  // glifo: marco de pantalla (borde blanco) + base
  const outer = roundedRectSDF(u, v, 0.18, 0.2, 0.64, 0.46, 0.05)
  const inner = roundedRectSDF(u, v, 0.235, 0.255, 0.53, 0.35, 0.03)
  const stand = rectSDF(u, v, 0.42, 0.72, 0.16, 0.07)
  const frame = Math.max(outer, -inner) // borde = dentro de outer y fuera de inner
  const glyph = Math.min(frame, stand)
  // cobertura con AA (~1.5px)
  const covGlyph = clamp(0.5 - glyph * size / 1.5)
  const covIcon = clamp(0.5 - corner * size / 1.5)
  // blanco del glifo sobre fondo
  const r = mix(bg[0], 255, covGlyph)
  const g = mix(bg[1], 255, covGlyph)
  const b = mix(bg[2], 255, covGlyph)
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * covIcon)]
}

function clamp(x: number): number {
  return Math.min(1, Math.max(0, x))
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** SDF de rectángulo redondeado (centrado en coordenadas normalizadas 0..1). */
function roundedRectSDF(u: number, v: number, x0: number, y0: number, w: number, h: number, r: number): number {
  const cx = x0 + w / 2
  const cy = y0 + h / 2
  const dx = Math.abs(u - cx) - (w / 2 - r)
  const dy = Math.abs(v - cy) - (h / 2 - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}

function rectSDF(u: number, v: number, x0: number, y0: number, w: number, h: number): number {
  const cx = x0 + w / 2
  const cy = y0 + h / 2
  const dx = Math.abs(u - cx) - w / 2
  const dy = Math.abs(v - cy) - h / 2
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0)
}

function render(size: number): Buffer {
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      const i = (y * size + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = a
    }
  }
  return encodePng(size, size, rgba)
}

// ---------- ICO (frames PNG embebidos) ----------
function buildIco(frames: Array<{ size: number; png: Buffer }>): Buffer {
  const count = frames.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type icon
  header.writeUInt16LE(count, 4)
  const entries: Buffer[] = []
  const datas: Buffer[] = []
  let offset = 6 + count * 16
  for (const f of frames) {
    const e = Buffer.alloc(16)
    e[0] = f.size >= 256 ? 0 : f.size
    e[1] = f.size >= 256 ? 0 : f.size
    e[2] = 0 // colores
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(f.png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += f.png.length
    entries.push(e)
    datas.push(f.png)
  }
  return Buffer.concat([header, ...entries, ...datas])
}

// ---------- generar ----------
const icon512 = render(512)
const icon256 = render(256)
const icon128 = render(128)
const icon32 = render(32)
const icon16 = render(16)
const icon48 = render(48)

writeFileSync(join(OUT, "icon.png"), icon512)
writeFileSync(join(OUT, "128x128.png"), icon128)
writeFileSync(join(OUT, "128x128@2x.png"), icon256)
writeFileSync(join(OUT, "32x32.png"), icon32)
writeFileSync(join(OUT, "Square512Logo.png"), icon512)
writeFileSync(join(OUT, "icon.ico"), buildIco([
  { size: 256, png: icon256 },
  { size: 48, png: icon48 },
  { size: 32, png: icon32 },
  { size: 16, png: icon16 },
]))

console.log("✓ íconos generados en", OUT)
