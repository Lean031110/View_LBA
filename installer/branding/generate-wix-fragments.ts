/**
 * ViewLBA — WiX Fragment Generator (replaces wix heat)
 * ====================================================
 * Walks the staging directory and generates WiX v4 fragment files
 * that include ALL files. This ensures the MSI contains the complete payload.
 *
 * Output: installer/windows-msi/*-fragments.wxs
 *
 * Each fragment has:
 *   <Fragment>
 *     <DirectoryRef Id="DIR_ID">
 *       <Component Id="..." Guid="*">
 *         <File Id="..." Source="$(var.PAYLOAD_DIR)\..." KeyPath="yes" />
 *       </Component>
 *       ...
 *     </DirectoryRef>
 *     <ComponentGroup Id="...">
 *       <ComponentRef Id="..." />
 *       ...
 *     </ComponentGroup>
 *   </Fragment>
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { join, relative, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")
const OUT_DIR = join(REPO_ROOT, "installer", "windows-msi")

interface HarvestConfig {
  dirName: string        // subdirectory in staging (e.g., "app")
  dirRef: string         // WiX DirectoryRef Id (e.g., "APP_DIR")
  componentGroup: string // WiX ComponentGroup Id (e.g., "AppFiles")
  excludes?: string[]   // directory names to exclude
}

const CONFIGS: HarvestConfig[] = [
  { dirName: "app", dirRef: "APP_DIR", componentGroup: "AppFiles", excludes: [] },
  { dirName: "mini-services", dirRef: "MINI_SERVICES_DIR", componentGroup: "MiniServicesFiles", excludes: [] },
  { dirName: "themes", dirRef: "THEMES_PF_DIR", componentGroup: "ThemesFiles", excludes: [] },
  { dirName: "public", dirRef: "PUBLIC_DIR", componentGroup: "PublicFiles", excludes: [] },
  { dirName: "config", dirRef: "CONFIG_DIR", componentGroup: "ConfigFiles", excludes: [] },
]

let componentCounter = 0

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1")
}

function walk(dir: string, basePath: string, excludes: string[] = []): Array<{ relativePath: string; fullPath: string }> {
  const files: Array<{ relativePath: string; fullPath: string }> = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (excludes.includes(entry.name)) continue
    const full = join(dir, entry.name)
    const rel = basePath ? `${basePath}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...walk(full, rel, excludes))
    } else if (entry.isFile()) {
      files.push({ relativePath: rel, fullPath: full })
    }
  }
  return files
}

function generateFragment(config: HarvestConfig, stagingDir: string): string {
  const sourceDir = join(stagingDir, config.dirName)
  const files = walk(sourceDir, "", config.excludes ?? [])

  componentCounter = 0
  const components: string[] = []
  const componentRefs: string[] = []

  for (const file of files) {
    const id = `f${config.dirName}_${componentCounter++}`
    const sourcePath = `$(var.PAYLOAD_DIR)\\${config.dirName}\\${file.relativePath.replace(/\//g, "\\")}`

    components.push(`      <Component Id="${id}" Guid="*">`)
    components.push(`        <File Id="${id}" Source="${sourcePath}" KeyPath="yes" />`)
    components.push(`      </Component>`)
    componentRefs.push(`      <ComponentRef Id="${id}" />`)
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Include xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="${config.dirRef}">
${components.join("\n")}
    </DirectoryRef>
    <ComponentGroup Id="${config.componentGroup}">
${componentRefs.join("\n")}
    </ComponentGroup>
  </Fragment>
</Include>
`
}

// Main
const stagingDir = process.argv[2] || join(REPO_ROOT, "dist", "release", "windows", "ViewLBA-Server")
console.log(`[wix-fragments] Generating fragments from: ${stagingDir}`)

mkdirSync(OUT_DIR, { recursive: true })

let totalFiles = 0
for (const config of CONFIGS) {
  const content = generateFragment(config, stagingDir)
  const outFile = join(OUT_DIR, `${config.dirName}-fragments.wxs`)
  writeFileSync(outFile, content)

  // Count files in this fragment
  const fileCount = (content.match(/<Component Id=/g) || []).length
  totalFiles += fileCount
  console.log(`[wix-fragments] ✓ ${config.dirName}-fragments.wxs (${fileCount} files)`)
}

console.log(`[wix-fragments] DONE — ${totalFiles} total files harvested`)
