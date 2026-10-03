/**
 * ViewLBA — Generador de iconos Windows oficiales desde logo-mark.svg
 * ====================================================================
 * Mision W: Branding oficial del instalador.
 *
 * FUENTE ÚNICA: public/logo-mark.svg (NO rediseñar, solo convertir)
 *
 * Salidas:
 *   installer/branding/generated/windows/
 *     ├── viewlba.ico        (multi-size: 16,32,48,64,128,256)
 *     ├── 16x16.png
 *     ├── 20x20.png
 *     ├── 24x24.png
 *     ├── 32x32.png
 *     ├── 48x48.png
 *     ├── 64x64.png
 *     ├── 128x128.png
 *     ├── 256x256.png
 *     └── 512x512.png
 *
 * Uso:
 *   bun installer/branding/generate-windows-icons.ts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")

// Source files — the OFFICIAL branding, NOT to be modified
const LOGO_MARK_SVG = join(REPO_ROOT, "public", "logo-mark.svg")
const LOGO_SVG = join(REPO_ROOT, "public", "logo.svg")

// Output directory
const OUT_DIR = join(REPO_ROOT, "installer", "branding", "generated", "windows")

// Sizes for PNG generation
const PNG_SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512]

// Sizes for ICO (multi-size icon)
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function renderSvgToPng(svgContent: string, size: number): Buffer {
  const resvg = new Resvg(svgContent, {
    fitTo: {
      mode: "width",
      value: size,
    },
    background: "rgba(0,0,0,0)", // transparent
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}

function buildIco(pngs: Map<number, Buffer>): Buffer {
  const sizes = Array.from(pngs.keys()).sort((a, b) => a - b)
  const count = sizes.length

  // ICO Header (6 bytes)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)     // reserved
  header.writeUInt16LE(1, 2)     // type = ICO
  header.writeUInt16LE(count, 4) // number of images

  // Directory entries (16 bytes each)
  const dirSize = 16 * count
  let dataOffset = 6 + dirSize

  const dirEntries: Buffer[] = []
  const pngDatas: Buffer[] = []

  for (const size of sizes) {
    const png = pngs.get(size)!
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)  // height
    entry.writeUInt8(0, 2)                        // color palette
    entry.writeUInt8(0, 3)                        // reserved
    entry.writeUInt16LE(1, 4)                    // color planes
    entry.writeUInt16LE(32, 6)                   // bits per pixel
    entry.writeUInt32LE(png.length, 8)           // image size
    entry.writeUInt32LE(dataOffset, 12)          // offset to image data
    dirEntries.push(entry)
    pngDatas.push(png)
    dataOffset += png.length
  }

  return Buffer.concat([header, ...dirEntries, ...pngDatas])
}

function main() {
  console.log("[branding] Generating Windows icons from official logo-mark.svg")

  // Verify sources exist
  if (!existsSync(LOGO_MARK_SVG)) {
    throw new Error(`Logo mark source not found: ${LOGO_MARK_SVG}`)
  }
  if (!existsSync(LOGO_SVG)) {
    throw new Error(`Logo source not found: ${LOGO_SVG}`)
  }

  // Read SVG content
  const svgContent = readFileSync(LOGO_MARK_SVG, "utf8")
  console.log(`[branding] Source: ${LOGO_MARK_SVG} (${svgContent.length} bytes)`)

  // Ensure output directory exists
  mkdirSync(OUT_DIR, { recursive: true })

  // Generate PNGs at all sizes
  const pngMap = new Map<number, Buffer>()
  for (const size of PNG_SIZES) {
    const png = renderSvgToPng(svgContent, size)
    const pngPath = join(OUT_DIR, `${size}x${size}.png`)
    writeFileSync(pngPath, png)
    pngMap.set(size, png)
    console.log(`[branding] ✓ ${size}x${size}.png (${png.length} bytes)`)
  }

  // Generate ICO with multi-size entries
  const icoPngs = new Map<number, Buffer>()
  for (const size of ICO_SIZES) {
    icoPngs.set(size, pngMap.get(size)!)
  }
  const ico = buildIco(icoPngs)
  const icoPath = join(OUT_DIR, "viewlba.ico")
  writeFileSync(icoPath, ico)
  console.log(`[branding] ✓ viewlba.ico (${ico.length} bytes, ${ICO_SIZES.length} sizes)`)

  // Compute SHA256 of source and generated assets
  const { createHash } = require("node:crypto")
  const logoMarkHash = createHash("sha256").update(readFileSync(LOGO_MARK_SVG)).digest("hex")
  const icoHash = createHash("sha256").update(ico).digest("hex")

  // Write branding manifest
  const manifest = {
    branding: {
      logo_source: "public/logo.svg",
      logo_mark_source: "public/logo-mark.svg",
      logo_mark_sha256: logoMarkHash,
      windows_ico_sha256: icoHash,
      generated_from: "public/logo-mark.svg",
      generated_at: new Date().toISOString(),
    },
    assets: {
      ico: "installer/branding/generated/windows/viewlba.ico",
      pngs: PNG_SIZES.map(s => `installer/branding/generated/windows/${s}x${s}.png`),
    },
    note: "All icons generated from public/logo-mark.svg. Do NOT modify the SVG sources.",
  }
  const manifestPath = join(OUT_DIR, "branding-manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`[branding] ✓ branding-manifest.json`)
  console.log(`[branding] Logo mark SHA256: ${logoMarkHash}`)
  console.log(`[branding] ICO SHA256: ${icoHash}`)
  console.log(`[branding] DONE — ${PNG_SIZES.length} PNGs + 1 ICO generated`)
}

main()
