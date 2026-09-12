/**
 * ViewLBA — Generador de los paquetes .vtheme OFICIALES (v3.1).
 *
 * Produce themes/ViewLBA-Classic.vtheme y themes/ViewLBA-Neon.vtheme a
 * partir de las definiciones integradas (src/lib/themes/builtin.ts):
 * MISMO código fuente de la verdad → los paquetes jamás divergen del motor.
 *
 * Uso: bun scripts/build-vtheme.ts
 * (determinista: ZIP STORED sin timestamps → mismos bytes en cada build)
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { buildVTheme } from "../src/lib/themes/package"
import { BUILTIN_THEMES } from "../src/lib/themes/builtin"
import type { ThemeSpec } from "../src/lib/themes/types"

const ROOT = resolve(import.meta.dir, "..")
const OUT_DIR = resolve(ROOT, "themes")

mkdirSync(OUT_DIR, { recursive: true })

const TARGETS = [
  { id: "viewlba-classic", file: "ViewLBA-Classic.vtheme" },
  { id: "viewlba-neon", file: "ViewLBA-Neon.vtheme" },
] as const

for (const t of TARGETS) {
  const builtin = BUILTIN_THEMES.find((b) => b.manifest.id === t.id)
  if (!builtin) throw new Error(`Tema integrado no encontrado: ${t.id}`)

  const buf = buildVTheme(builtin.manifest, builtin.spec as ThemeSpec)
  const out = resolve(OUT_DIR, t.file)
  writeFileSync(out, buf)
  const sha = new Bun.CryptoHasher("sha256").update(buf).digest("hex")
  console.log(`✓ ${t.file} (${buf.length} bytes) — SHA-256 ${sha}`)
}

console.log("\nLos paquetes se generan desde builtin.ts (fuente única de la verdad).")
console.log("· Classic y Neon ya vienen INTEGRADOS en ViewLBA (siempre disponibles).")
console.log("· Sus .vtheme son la EXPORTACIÓN oficial del formato: importarlos en un")
console.log("  sistema que ya los integra se rechaza limpiamente (id reservado — no se")
console.log("  puede sobrescribir un tema integrado); sirven como referencia del formato")
console.log("  y como plantilla segura para crear temas nuevos.")
console.log("Instalación de temas propios: Administración → Temas de Pantalla → Importar tema (.vtheme)")
