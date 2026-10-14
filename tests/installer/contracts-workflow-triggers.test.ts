/**
 * Contrato: el workflow build-windows-installer.yml se dispara cuando
 * cambia CUALQUIER archivo del payload distribuible (P0).
 *
 * El instalador de Windows es el artefacto DISTRIBUTABLE. Si cambia el
 * código de la app, los mini-servicios, Prisma, los temas, los scripts
 * de runtime o cualquier otra fuente que stage-windows.ts copia al
 * staging, el workflow DEBE dispararse.
 *
 * Este test fija el contrato con TRES niveles de rigor:
 *
 *   1. PRESENCIA: el workflow declara paths: y contiene ciertas rutas
 *      mínimas (package.json, bun.lock, VERSION, installer/**, etc.).
 *
 *   2. COBERTURA DINÁMICA: parsea scripts/stage-windows.ts para
 *      encontrar todos los `copyDir(join(REPO_ROOT, "<subdir>"), ...)`
 *      y `copyFile(<src>, ...)` que copian del repo al staging. Cada
 *      subdir copiado debe estar cubierto por un patrón en paths:.
 *      Si stage-windows.ts añade un nuevo copyDir, este test falla
 *      hasta que paths: se actualice.
 *
 *   3. SIMULACIÓN DE ESCENARIOS: para archivos runtime concretos
 *      (scripts/start.ts, scripts/backup.ts, src/lib/auth.ts,
 *      mini-services/realtime-service/index.ts, etc.), verifica que
 *      el matcher de paths: cubre ese archivo. Esto valida que los
 *      patrones declarados realmente funcionan, no solo existen.
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, REPO_ROOT } from "./_helpers"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const WORKFLOW = ".github/workflows/build-windows-installer.yml"
const STAGE = "scripts/stage-windows.ts"

// ───────────────────────────────────────────────────────────────────
// PARSER: extract on.push.paths from workflow YAML
// ───────────────────────────────────────────────────────────────────

/** Extrae la lista paths del bloque `on.push:` de un workflow YAML. */
function extractPushPaths(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/)
  let inPush = false
  let inPaths = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*push:\s*$/.test(line) || /^on:\s*$/.test(line)) {
      inPush = true
      inPaths = false
      continue
    }
    if (inPush && /^(pull_request|workflow_dispatch|schedule|concurrency|permissions|env|jobs|name):/.test(line)) {
      inPush = false
      inPaths = false
      continue
    }
    if (inPush && /^\s*paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths && /^\s*(branches|tags|branches-ignore|paths-ignore|workflow_dispatch|pull_request|concurrency|permissions):/.test(line)) {
      inPaths = false
      continue
    }
    if (inPaths) {
      const m = line.match(/^\s*-\s*"?([^"#]+?)"?\s*(?:#.*)?$/)
      if (m && m[1]) out.push(m[1].trim())
    }
  }
  return out
}

// ───────────────────────────────────────────────────────────────────
// MATCHER: GitHub Actions path glob semantics (subset)
//   - "foo/**" matches "foo" itself and any "foo/..." descendant
//   - "foo/*" matches only direct children of foo (no nested)
//   - "foo" matches exactly "foo"
//   - "?" matches any single char, "*" matches any chars except "/"
//   (https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore)
// ───────────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  // Convert glob to regex.
  // Handle "**" (matches any path including /), then "*" (matches any non-/),
  // then "?" (matches single non-/).
  let pattern = "^"
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      // ** — match anything (including /)
      pattern += ".*"
      i += 2
      // Skip trailing / if present (foo/** matches foo/anything OR foo itself)
      if (glob[i] === "/") i += 1
    } else if (c === "*") {
      // * — match any chars except /
      pattern += "[^/]*"
      i += 1
    } else if (c === "?") {
      pattern += "[^/]"
      i += 1
    } else if (".+^$(){}[]|\\".includes(c)) {
      pattern += "\\" + c
      i += 1
    } else {
      pattern += c
      i += 1
    }
  }
  pattern += "$"
  return new RegExp(pattern)
}

/** Predice si una ruta del repo dispararía el workflow. */
function triggersPath(paths: string[], repoRel: string): boolean {
  // Normalize to forward slashes
  const rel = repoRel.replace(/\\/g, "/")
  for (const p of paths) {
    if (p === rel) return true
    const re = globToRegex(p)
    if (re.test(rel)) return true
  }
  return false
}

// ───────────────────────────────────────────────────────────────────
// PARSER: extract copyDir/copyFile source paths from stage-windows.ts
// ───────────────────────────────────────────────────────────────────

/**
 * Lee scripts/stage-windows.ts y extrae todos los paths REPO_ROOT-relativos
 * que se copian al staging vía copyDir() o copyFile().
 *
 * Patrón buscado (con variable extraction):
 *   const xxxSrc = join(REPO_ROOT, "<subdir>")
 *   copyDir(xxxSrc, ...)
 *   copyFile(<some path that resolves to REPO_ROOT/<subdir>>, ...)
 *
 * Devuelve una lista de subdirs/archivos REPO_ROOT-relativos que stage-windows.ts
 * copia al staging. Esto es la "source surface" del payload.
 */
function extractStageSources(stageSrc: string): string[] {
  const sources: Set<string> = new Set()

  // Find all: const xxx = join(REPO_ROOT, "<path>", ...)
  // This captures the variable name → path mapping.
  const varToPath = new Map<string, string>()
  const varDeclRe = /const\s+(\w+)\s*=\s*join\(\s*REPO_ROOT\s*,\s*"([^"]+)"\s*(?:,\s*[^)]+)*\)/g
  let m: RegExpExecArray | null
  while ((m = varDeclRe.exec(stageSrc)) !== null) {
    varToPath.set(m[1], m[2])
  }

  // Find all: const xxx = join(join(REPO_ROOT, "<a>"), "<b>", ...)
  // (handles nested join calls)
  const nestedVarDeclRe = /const\s+(\w+)\s*=\s*join\(\s*join\(\s*REPO_ROOT\s*,\s*"([^"]+)"\s*\)\s*,\s*"([^"]+)"\s*(?:,\s*[^)]+)*\)/g
  while ((m = nestedVarDeclRe.exec(stageSrc)) !== null) {
    varToPath.set(m[1], m[2] + "/" + m[3])
  }

  // Find all: copyDir(<varname>, ...) — extract the variable used as src
  const copyDirRe = /copyDir\(\s*(\w+)\s*,/g
  while ((m = copyDirRe.exec(stageSrc)) !== null) {
    const varName = m[1]
    if (varToPath.has(varName)) {
      sources.add(varToPath.get(varName)!)
    }
  }

  // Find all: copyFile(<varname>, ...)
  const copyFileRe = /copyFile\(\s*(\w+)\s*,/g
  while ((m = copyFileRe.exec(stageSrc)) !== null) {
    const varName = m[1]
    if (varToPath.has(varName)) {
      sources.add(varToPath.get(varName)!)
    }
  }

  // Also find direct join(REPO_ROOT, "...") inside copyDir/copyFile
  const directRe = /copy(?:Dir|File)\(\s*join\(\s*REPO_ROOT\s*,\s*"([^"]+)"\s*\)/g
  while ((m = directRe.exec(stageSrc)) !== null) {
    sources.add(m[1])
  }

  return Array.from(sources).sort()
}

// ───────────────────────────────────────────────────────────────────
// TESTS
// ───────────────────────────────────────────────────────────────────

describe("CONTRATO: build-windows-installer.yml dispara en cambios del payload (P0)", () => {
  const yaml = readRepoFile(WORKFLOW)
  const paths = extractPushPaths(yaml)
  const stageSrc = readRepoFile(STAGE)
  const stageSources = extractStageSources(stageSrc)

  test("el workflow EXISTE y declara on.push.paths", () => {
    expect(yaml.length).toBeGreaterThan(0)
    expect(paths.length).toBeGreaterThan(0)
    // Minimum required entries
    const required = [
      "package.json", "bun.lock", "VERSION",
      "config/**", "installer/**",
      "scripts/**",  // P0 — required for runtime scripts copied to staging
    ]
    for (const r of required) {
      expect(paths).toContain(r)
    }
  })

  test("paths: incluye scripts/** (runtime scripts copiados al staging)", () => {
    // stage-windows.ts line 219: copyDir(scriptsSrc, appDir/scripts, [...])
    // copies the WHOLE scripts/ directory into staging. So any change in
    // scripts/ that's part of the payload must trigger the build.
    expect(paths).toContain("scripts/**")
  })

  test("NIVEL 2: cada copyDir/copyFile de stage-windows.ts está cubierto por paths:", () => {
    // Para cada fuente que stage-windows.ts copia al staging, verificar
    // que paths: tiene un patrón que la cubre. Si stage-windows.ts añade
    // un nuevo copyDir, este test fallará.
    //
    // EXCEPCIONES (build artifacts, NO source):
    //   - .next/         → creado por `bun run build` DENTRO del workflow
    //   - dist/          → creado por `bun scripts/stage-windows.ts` DENTRO del workflow
    //   - node_modules/  → creado por `bun install --frozen-lockfile` DENTRO del workflow
    //                        (incluye node_modules/.prisma/ generado por `bunx prisma generate`)
    //
    // Estas paths NO deben estar en paths: porque son SALIDA del workflow,
    // no entrada. Si un archivo cambia ahí, es porque el workflow mismo
    // lo modificó — no tiene sentido disparar de nuevo.
    const buildArtifactsAllowList = new Set<string>([
      ".next",         // bun run build output (generated in workflow)
      "dist",          // stage-windows.ts + bundle-server.ts output (generated in workflow)
      "node_modules",  // bun install + prisma generate output (generated in workflow)
    ])
    const uncovered: string[] = []
    for (const src of stageSources) {
      if (buildArtifactsAllowList.has(src)) continue
      // src is REPO_ROOT-relative, e.g. "scripts" or "prisma" or "themes"
      // Test: would a change at "<src>/foo" trigger the workflow?
      const testPath = src + "/test-file.txt"
      if (!triggersPath(paths, testPath)) {
        uncovered.push(`  - FALTA cobertura para "${src}/"  (test path: ${testPath})`)
      }
    }
    if (uncovered.length > 0) {
      throw new Error(
        `paths: en ${WORKFLOW} NO cubre TODAS las fuentes que ${STAGE} copia al staging:\n` +
        uncovered.join("\n") +
        `\n\nstage-windows.ts copia estas fuentes al staging — el workflow DEBE dispararse cuando cambien.`,
      )
    }
  })

  test("NIVEL 3a: cambio exclusivo en src/ dispararía el workflow", () => {
    const candidates = [
      "src/app/api/health/route.ts",
      "src/components/admin/AdminApp.tsx",
      "src/lib/auth.ts",
    ]
    for (const f of candidates) {
      if (!triggersPath(paths, f)) {
        throw new Error(`Un cambio exclusivo en ${f} NO dispararía el workflow. paths: debe incluir "src/**".`)
      }
    }
  })

  test("NIVEL 3b: cambio exclusivo en mini-services/ dispararía el workflow", () => {
    const f = "mini-services/realtime-service/index.ts"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "mini-services/**"`)
    }
  })

  test("NIVEL 3c: cambio exclusivo en prisma/ dispararía el workflow", () => {
    const f = "prisma/schema.prisma"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "prisma/**"`)
    }
  })

  test("NIVEL 3d: cambio exclusivo en themes/ dispararía el workflow", () => {
    const f = "themes/ViewLBA-Neon.vtheme"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "themes/**"`)
    }
  })

  test("NIVEL 3e: cambio en VERSION / package.json / bun.lock dispararía el workflow", () => {
    for (const f of ["VERSION", "package.json", "bun.lock"]) {
      if (!triggersPath(paths, f)) {
        throw new Error(`${f} NO está cubierto por paths:`)
      }
    }
  })

  test("NIVEL 3f: cambio exclusivo en scripts/start.ts (runtime, copiado al payload) dispararía", () => {
    // stage-windows.ts line 219 copies the WHOLE scripts/ directory to
    // app/scripts/ in the staging. scripts/start.ts is the runtime entry
    // used to start the server. A change in it ends up in the payload.
    const candidates = [
      "scripts/start.ts",
      "scripts/backup.ts",
      "scripts/restore.ts",
      "scripts/logs-purge.ts",
      "scripts/media-gc.ts",
      "scripts/init-production.ts",
      "scripts/install.ts",
      "scripts/build.ts",
      "scripts/lib/prompt.ts",
      "scripts/lib/env-file.ts",
      "scripts/lib/production-init.ts",
    ]
    for (const f of candidates) {
      if (!triggersPath(paths, f)) {
        throw new Error(
          `Un cambio exclusivo en ${f} NO dispararía el workflow. ` +
          `paths: debe incluir "scripts/**" porque stage-windows.ts copia el directorio scripts/ entero al staging.`,
        )
      }
    }
  })

  test("NIVEL 3g: cambio en config/ (templates) dispararía el workflow", () => {
    const f = "config/server.env.example"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "config/**"`)
    }
  })

  test("stage-windows.ts existe (contrato real, no especulativo)", () => {
    expect(existsSync(join(REPO_ROOT, STAGE))).toBe(true)
  })

  test("DEBUG: fuentes detectadas en stage-windows.ts", () => {
    // Test informativo: imprime las fuentes detectadas para inspección.
    // Si la lista está vacía, el parser puede estar roto.
    console.log(`  Fuentes detectadas en ${STAGE}:`)
    for (const src of stageSources) {
      const testPath = src + "/test-file.txt"
      const ok = triggersPath(paths, testPath)
      console.log(`    ${ok ? "OK " : "MISS"}  ${src}/  (test path: ${testPath})`)
    }
    expect(stageSources.length).toBeGreaterThan(0)
  })
})
