/** Verificación: los .vtheme oficiales PARSEAN con el pipeline completo. */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseVTheme } from "../src/lib/themes/package"

for (const f of ["ViewLBA-Classic.vtheme", "ViewLBA-Neon.vtheme"]) {
  const buf = readFileSync(resolve(import.meta.dir, "../themes", f))
  const p = parseVTheme(buf, "3.1.0")
  console.log(`✓ ${f}: id=${p.manifest.id} name="${p.manifest.name}" v${p.manifest.version} assets=${p.assets.length}`)
}
