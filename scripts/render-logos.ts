/** Renderiza los logos SVG oficiales a PNG (para el PDF del manual). */
import sharp from "sharp"
import { mkdirSync } from "node:fs"

mkdirSync("docs/manual/assets", { recursive: true })
await sharp("public/logo-mark.svg", { density: 300 }).resize(600, 600, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile("docs/manual/assets/logo-mark.png")
await sharp("public/logo.svg", { density: 300 }).resize(1600, 480, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile("docs/manual/assets/logo-full.png")
console.log("✓ logos renderizados (logo-mark.png · logo-full.png)")
