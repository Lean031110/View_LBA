/**
 * ViewLBA — WiX Fragment Generator (replaces wix heat)
 * ====================================================
 * Walks the staging directory and generates WiX v4 fragment files
 * that include ALL files. Ensures the MSI contains the complete payload
 * AND preserves the subdirectory structure (so files like
 * mini-services/stream-service/index.ts install to the correct path).
 *
 * Output: installer/windows-msi/*-fragments.wxs
 *
 * Each fragment has:
 *   <Fragment>
 *     <DirectoryRef Id="DIR_ID">
 *       <Directory Id="..." Name="subdir">
 *         <Directory Id="..." Name="subsubdir">
 *           <Component Id="..." Guid="*">
 *             <File Id="..." Source="$(var.PAYLOAD_DIR)\..." KeyPath="yes" />
 *           </Component>
 *         </Directory>
 *         ...
 *       </Directory>
 *       ...
 *     </DirectoryRef>
 *     <ComponentGroup Id="...">
 *       <ComponentRef Id="..." />
 *       ...
 *     </ComponentGroup>
 *   </Fragment>
 *
 * The Directory element is REQUIRED for subdirectories — without it, WiX
 * installs the file with the WRONG path (strips the subdirectory from the
 * install path, causing filename conflicts and broken layout).
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { join, relative, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

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
  { dirName: "app", dirRef: "APP_DIR", componentGroup: "AppFiles", excludes: [".git", ".cache"] },
  { dirName: "mini-services", dirRef: "MINI_SERVICES_DIR", componentGroup: "MiniServicesFiles", excludes: [".git", ".cache"] },
  { dirName: "themes", dirRef: "THEMES_PF_DIR", componentGroup: "ThemesFiles", excludes: [".git"] },
  { dirName: "public", dirRef: "PUBLIC_DIR", componentGroup: "PublicFiles", excludes: [".git"] },
  { dirName: "config", dirRef: "CONFIG_DIR", componentGroup: "ConfigFiles", excludes: [".git"] },
]

interface FileEntry {
  relativePath: string  // path relative to sourceDir, with forward slashes
  fullPath: string       // absolute path on disk
}

/** Walk a directory recursively, returning all files with their relative paths. */
function walk(dir: string, basePath: string, excludes: string[] = []): FileEntry[] {
  const files: FileEntry[] = []
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

/** Sanitize a string for use as a WiX identifier (A-Z, a-z, 0-9, _, .). */
function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.]/g, "_").replace(/^(\d)/, "_$1")
}

/** Generate a deterministic GUID from a string input (SHA256-based). */
function deterministicGuid(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex")
  return `${hash.substring(0,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}-${hash.substring(16,20)}-${hash.substring(20,32)}`.toUpperCase()
}

/**
 * Build a tree from file paths and emit WiX XML with nested <Directory>
 * elements containing <Component>/<File> elements at the leaves.
 *
 * Each subdir becomes a <Directory Id="..." Name="..."> element. IDs are
 * generated using SEPARATE counters for directories and components (so a
 * dir and a component can never share an ID). The Directory element is
 * REQUIRED for subdirectories — without it, WiX strips the subdir from
 * the install path, causing filename conflicts (e.g., two services each
 * with index.ts would collide at mini-services/index.ts).
 */
function buildNestedXml(config: HarvestConfig, files: FileEntry[]): { dirXml: string; componentRefs: string[] } {
  const safeDirName = sanitizeId(config.dirName)
  const componentRefs: string[] = []
  let dirCounter = 0
  let compCounter = 0

  interface TreeNode {
    name: string
    isDir: boolean
    children: Map<string, TreeNode>
    file?: FileEntry
  }

  const root: TreeNode = {
    name: config.dirName,
    isDir: true,
    children: new Map(),
  }

  // Insert each file into the tree
  for (const file of files) {
    const parts = file.relativePath.split("/")
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        // Leaf: file
        current.children.set(part, {
          name: part,
          isDir: false,
          children: new Map(),
          file,
        })
      } else {
        // Directory
        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            isDir: true,
            children: new Map(),
          })
        }
        current = current.children.get(part)!
      }
    }
  }

  // Recursively emit XML for the tree
  function emit(node: TreeNode, depth: number): string {
    const indent = "  ".repeat(depth)
    if (!node.isDir) {
      // Leaf: emit Component + File
      const file = node.file!
      const id = `f${safeDirName}_${compCounter++}`
      const sourcePath = `$(var.PAYLOAD_DIR)\\${config.dirName}\\${file.relativePath.replace(/\//g, "\\")}`
      const guid = deterministicGuid(`${config.dirName}\\${file.relativePath.replace(/\//g, "\\")}`)
      componentRefs.push(`${indent}  <ComponentRef Id="${id}" />`)
      return `${indent}<Component Id="${id}" Guid="${guid}">
${indent}  <File Id="${id}" Source="${sourcePath}" KeyPath="yes" />
${indent}</Component>`
    }

    // Directory: emit <Directory Id=... Name=...> children </Directory>
    const childXml: string[] = []
    for (const child of node.children.values()) {
      childXml.push(emit(child, depth + 1))
    }

    if (node === root) {
      // Root: just emit children (the DirectoryRef wraps them)
      return childXml.join("\n")
    }

    const dirId = `dir_${safeDirName}_${dirCounter++}`
    return `${indent}<Directory Id="${dirId}" Name="${node.name}">
${childXml.join("\n")}
${indent}</Directory>`
  }

  const dirXml = emit(root, 0)
  return { dirXml, componentRefs }
}

function generateFragment(config: HarvestConfig, stagingDir: string): string {
  const sourceDir = join(stagingDir, config.dirName)
  const files = walk(sourceDir, "", config.excludes ?? [])

  const { dirXml, componentRefs } = buildNestedXml(config, files)

  return `<?xml version="1.0" encoding="UTF-8"?>
<Include xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="${config.dirRef}">
${dirXml}
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

  // Count files in this fragment (number of <File> elements)
  const fileCount = (content.match(/<File Id=/g) || []).length
  totalFiles += fileCount
  console.log(`[wix-fragments] ✓ ${config.dirName}-fragments.wxs (${fileCount} files)`)
}

console.log(`[wix-fragments] DONE — ${totalFiles} total files harvested`)
