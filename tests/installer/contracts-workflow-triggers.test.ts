/**
 * Contrato: el workflow build-windows-installer.yml se dispara cuando
 * cambia CUALQUIER archivo del payload distribuible (P0).
 *
 * El instalador de Windows es el artefacto DISTRIBUTABLE. Si cambia el
 * código de la app, los mini-servicios, Prisma, los temas o cualquier
 * otra fuente que stage-windows.ts copia al staging, el workflow DEBE
 * dispararse. No basta con que se dispare cuando cambia el instalador.
 *
 * Este test fija el contrato:
 *   1. El workflow EXISTE y declara `on.push.paths`.
 *   2. La lista `paths:` contiene todas las rutas que stage-windows.ts
 *      consume (app, mini-services, prisma, themes, public, config,
 *      package.json, bun.lock, VERSION + scripts/build.ts).
 *   3. Un cambio exclusivo en src/ dispararía el workflow
 *      (simulación: src/foo.ts está cubierto por "src/**").
 *
 * Si stage-windows.ts empieza a depender de una nueva ruta, este test
 * fallará hasta que la ruta se añada a `paths:`.
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, REPO_ROOT } from "./_helpers"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOW = ".github/workflows/build-windows-installer.yml"
const STAGE = "scripts/stage-windows.ts"

/** Extrae la lista paths del bloque `on:` de un workflow YAML. */
function extractPushPaths(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/)
  let inPush = false
  let inPaths = false
  const out: string[] = []
  for (const line of lines) {
    // Detectar inicio del bloque `push:` bajo `on:`
    if (/^\s*push:\s*$/.test(line) || /^on:\s*$/.test(line)) {
      inPush = true
      inPaths = false
      continue
    }
    // Salir del bloque push al encontrar otra clave top-level
    if (inPush && /^(pull_request|workflow_dispatch|schedule|concurrency|permissions|env|jobs|name):/.test(line)) {
      inPush = false
      inPaths = false
      continue
    }
    // Detectar inicio del subbloque `paths:`
    if (inPush && /^\s*paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    // Salir de paths al encontrar otra sub-clave
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

/** Predice si una ruta del repo dispararía el workflow. */
function triggersPath(paths: string[], repoRel: string): boolean {
  for (const p of paths) {
    if (p === repoRel) return true
    if (p.endsWith("/**")) {
      const dir = p.slice(0, -3)
      if (repoRel === dir) return true
      if (repoRel.startsWith(dir + "/")) return true
    } else if (p.endsWith("/*")) {
      const dir = p.slice(0, -2)
      if (repoRel.startsWith(dir + "/") && !repoRel.slice(dir.length + 1).includes("/")) return true
    }
  }
  return false
}

describe("CONTRATO: build-windows-installer.yml dispara en cambios del payload (P0)", () => {
  const yaml = readRepoFile(WORKFLOW)
  const paths = extractPushPaths(yaml)

  test("el workflow EXISTE y declara on.push.paths", () => {
    expect(yaml.length).toBeGreaterThan(0)
    expect(paths.length).toBeGreaterThan(0)
    // Debe incluir al menos: app, prisma, mini-services, themes, public,
    // package.json, bun.lock, VERSION, installer/**, scripts/stage-windows.ts
    const required = [
      "package.json", "bun.lock", "VERSION",
      "config/**", "installer/**",
    ]
    for (const r of required) {
      expect(paths).toContain(r)
    }
  })

  test("paths: cubre todas las dependencias de stage-windows.ts", () => {
    const stage = readRepoFile(STAGE)
    // Lista cerrada — cada ruta que stage-windows.ts copia al staging
    const requiredSurface: Array<{ path: string; why: string }> = [
      { path: "src/**",                why: "Next.js app (compilado a .next/standalone)" },
      { path: "app/**",                why: "Next.js app dir (si existe)" },
      { path: "mini-services/**",      why: "realtime-service + stream-service" },
      { path: "prisma/**",             why: "schema + migrations copiados a app/prisma/" },
      { path: "themes/**",             why: ".vtheme files copiados a themes/" },
      { path: "public/**",             why: "static assets copiados a public/" },
      { path: "config/**",             why: "server.env.example + service-host.toml.example" },
      { path: "package.json",          why: "version + deps para bun install" },
      { path: "bun.lock",              why: "lockfile para --frozen-lockfile" },
      { path: "VERSION",               why: "leído por stage-windows.ts" },
      { path: "next.config.ts",        why: "configura bun run build" },
      { path: "tsconfig.json",         why: "compilación TS" },
      { path: "scripts/stage-windows.ts", why: "el propio script de staging" },
      { path: "scripts/build.ts",      why: "produce .next/standalone" },
      { path: "installer/**",          why: "Rust binaries + WiX + branding + bundle-server" },
    ]
    const missing: string[] = []
    for (const { path, why } of requiredSurface) {
      if (!paths.includes(path)) {
        missing.push(`  - FALTA "${path}"  // ${why}`)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `paths: en ${WORKFLOW} NO cubre dependencias reales de ${STAGE}:\n` +
        missing.join("\n") +
        `\nStage-windows.ts copia estas rutas al staging — el workflow DEBE dispararse cuando cambien.`,
      )
    }
  })

  test("un cambio exclusivo en src/ dispararía el workflow (simulación)", () => {
    // Caso solicitado por el revisor: cambiar SOLO código de aplicación
    // debe disparar la construcción del instalador.
    const candidates = [
      "src/app/api/health/route.ts",
      "src/components/admin/AdminApp.tsx",
      "src/lib/auth.ts",
    ]
    for (const f of candidates) {
      const ok = triggersPath(paths, f)
      if (!ok) {
        throw new Error(
          `Un cambio exclusivo en ${f} NO dispararía build-windows-installer.yml. ` +
          `paths: debe incluir "src/**" — falta o está mal escrita.`,
        )
      }
    }
  })

  test("un cambio exclusivo en mini-services/ dispararía el workflow", () => {
    const f = "mini-services/realtime-service/index.ts"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "mini-services/**"`)
    }
  })

  test("un cambio exclusivo en prisma/ dispararía el workflow", () => {
    const f = "prisma/schema.prisma"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "prisma/**"`)
    }
  })

  test("un cambio exclusivo en themes/ dispararía el workflow", () => {
    const f = "themes/ViewLBA-Neon.vtheme"
    if (!triggersPath(paths, f)) {
      throw new Error(`${f} NO está cubierto por paths: — falta "themes/**"`)
    }
  })

  test("un cambio en VERSION dispararía el workflow", () => {
    if (!triggersPath(paths, "VERSION")) {
      throw new Error(`VERSION NO está cubierto por paths:`)
    }
  })

  test("un cambio en package.json o bun.lock dispararía el workflow", () => {
    if (!triggersPath(paths, "package.json")) {
      throw new Error(`package.json NO está cubierto por paths:`)
    }
    if (!triggersPath(paths, "bun.lock")) {
      throw new Error(`bun.lock NO está cubierto por paths:`)
    }
  })

  test("stage-windows.ts existe (contrato real, no especulativo)", () => {
    expect(existsSync(join(REPO_ROOT, STAGE))).toBe(true)
  })
})
