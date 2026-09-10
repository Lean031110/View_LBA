/**
 * Manifiest de BUILD del instalador — trazabilidad commit ↔ binario.
 *
 * Combina el manifest del payload (bundle-server) con el artefacto final:
 *   product · version · platform · arch · git commit · timestamp ·
 *   bun (build) · bun (payload) · tauri · tamaño del payload ·
 *   nombre del artefacto · SHA256 del artefacto · offline=true
 *
 * Uso:
 *   bun installer/package/build-manifest.ts \
 *     --staging=dist/release/linux/ViewLBA-Server \
 *     --artifact=dist/release/linux/out/ViewLBA-Server-1.0.1-rc.1-x86_64.deb \
 *     --tauri=2.11.4 \
 *     --out=dist/release/linux/out/manifest-linux.json
 *
 * Sin dependencias externas; falla si falta el artefacto.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
}

const staging = arg("staging")
const artifact = arg("artifact")
const tauri = arg("tauri") ?? "unknown"
const out = arg("out")

if (!staging || !artifact || !out) {
  console.error("uso: build-manifest.ts --staging=<dir> --artifact=<file> --tauri=<ver> --out=<file>")
  process.exit(1)
}
if (!existsSync(resolve(artifact))) {
  console.error(`✗ el artefacto no existe: ${artifact} (el job NO debe salir verde sin instalador)`)
  process.exit(1)
}

const payloadManifest = JSON.parse(readFileSync(resolve(staging, "manifest.json"), "utf8"))
const buf = readFileSync(resolve(artifact))
const sha256 = createHash("sha256").update(buf).digest("hex")

const manifest = {
  ...payloadManifest,
  tauriVersion: tauri,
  artifact: {
    name: basename(artifact),
    bytes: statSync(resolve(artifact)).size,
    sha256,
  },
}

writeFileSync(resolve(out), JSON.stringify(manifest, null, 2))
console.log(`✓ manifest: ${out}`)
console.log(`  artifact: ${manifest.artifact.name} (${(manifest.artifact.bytes / 1024 / 1024).toFixed(1)} MB)`)
console.log(`  sha256:   ${sha256.slice(0, 16)}…`)
console.log(`  payload:  ${(manifest.payloadBytes / 1024 / 1024).toFixed(0)} MB · ${manifest.payloadFiles} archivos`)
