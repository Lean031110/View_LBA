/**
 * E2E fixtures — constructor de paquetes .vtheme para los tests de temas.
 *
 * Reutiliza el ESCRITOR ZIP del propio motor (src/lib/themes/zip) → si el
 * formato del paquete diverge del validador, los E2E lo detectan.
 * El entorno E2E corre CON licencia activa (temas habilitados).
 */
import { writeZip } from "../../../src/lib/themes/zip"
import { BUILTIN_THEMES } from "../../../src/lib/themes/builtin"
import type { ThemeManifest, ThemeSpecInput } from "../../../src/lib/themes/types"

/** Construye un .vtheme válido con el spec del tema integrado dado (id único). */
export function buildE2eVTheme(builtinId: "viewlba-classic" | "viewlba-neon", packageId: string): Buffer {
  const t = BUILTIN_THEMES.find((b) => b.manifest.id === builtinId)!
  const manifest: ThemeManifest = { ...t.manifest, id: packageId, name: `${t.manifest.name} E2E` }
  const spec: ThemeSpecInput = t.spec
  return writeZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "theme.json", data: Buffer.from(JSON.stringify(spec), "utf8") },
  ])
}

/** Construye un .vtheme MALICIOSO (para el test de rechazo en UI). */
export function buildE2eMaliciousVTheme(): Buffer {
  return writeZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: "evil-e2e", name: "Evil", author: "x", version: "1.0.0", description: "", minViewLbaVersion: "3.1.0", licenseTier: "full" }), "utf8") },
    { name: "theme.json", data: Buffer.from(JSON.stringify({ clock: { style: "classic" } }), "utf8") },
    { name: "assets/evil.js", data: Buffer.from("alert(1)") },
  ])
}
