/**
 * STAGING DE PRODUCCIÓN — payload explícito del servidor (installer oficial).
 *
 * PRINCIPIO: BUILD DEPENDENCIES ≠ RUNTIME DEPENDENCIES.
 *
 * El entorno de COMPILACIÓN (repo con node_modules completos, next build,
 * Turbopack, Tailwind, TypeScript) puede ser grande: vive en el runner y NO se
 * distribuye. El PAYLOAD distribuido es EXPLÍCITO y contiene SOLO lo necesario
 * para EJECUTAR el servidor en producción y aplicar migraciones durante la
 * instalación — 100% offline.
 *
 * Estructura garantizada (determinista):
 *   <stage>/resources/server/
 *     .next/standalone/     server.js + node_modules trazados por Next + static + public
 *     package.json          manifest (scripts de runtime: start/backup/logs-purge)
 *     bun.lock              reproducibilidad en reparaciones con red
 *     prisma/               schema.prisma + migrations/ + seed.ts  (migrate deploy offline)
 *     scripts/              start/backup/restore/logs-purge/media-gc/init-production + lib/
 *     src/lib/              SOLO los módulos que los scripts de runtime importan
 *     mini-services/        realtime + stream (código + sus node_modules runtime)
 *     node_modules/         PODADO: prisma CLI + @prisma/client + engines + zod
 *                           (ver PAYLOAD_ROOTS — walk transitivo, sin devDeps)
 *     configs mínimos       next.config.ts, tsconfig.json, postcss/tailwind/components
 *
 * DECISIONES DOCUMENTADAS (qué entra y qué NO, y por qué):
 *   · .next/standalone: Next traza TODO lo que server.js necesita en runtime
 *     (next, react, sharp, @prisma/client, engines) → autosuficiente.
 *     ⚠ Next espeja el árbol del repo (tracing root) — por eso se copia por
 *     WHITELIST: sin espejo no habría otra forma de excluir db/, .env, logs/,
 *     download/, docs/… que Next arrastraría dentro (fuga real de datos).
 *   · prisma CLI (67 MB) + @prisma/engines (36 MB): imprescindibles para
 *     `prisma migrate deploy` / `migrate status` DURANTE la instalación
 *     (initializeProduction los ejecuta sin red). Documentado en INSTALLER.md.
 *   · @prisma/client + .prisma/client (generado): lo importan scripts/backup.ts,
 *     scripts/logs-purge.ts (timers systemd) y prisma/seed.ts → deben existir
 *     en el node_modules del appDir, no solo dentro del standalone.
 *   · zod (8 MB): lo importa src/lib/env.ts (production-init/repair). Barato
 *     y evita romper `bun scripts/init-production.ts` en reparaciones.
 *   · `next` (202 MB) EXCLUIDO a propósito: el COMPILER/SWC es dependencia de
 *     build. En runtime el servidor usa el standalone trazado; la lógica de
 *     instalación (auth/validators/prisma) va EMBEBIDA en el sidecar compilado
 *     (bun build --compile — verificado). Reparar DESDE FUENTE con
 *     scripts/init-production.ts requiere `bun install` (con red) — documentado.
 *   · devDependencies (typescript, eslint, playwright, tailwind, @types…):
 *     EXCLUIDOS. Tests/fixtures/reports/docs: EXCLUIDOS.
 *   · Bun runtime + NSSM (windows): se descargan durante el BUILD (red permitida);
 *     el instalador final NO necesita red.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, relative, resolve } from "node:path"

// ------------------------------------------------------------------ contrato

export interface PayloadOptions {
  /** Raíz del repo (entorno de build: deps completas, next build). */
  root: string
  /** Destino: <...>/resources/server (se limpia antes). */
  serverDir: string
  platform: "linux" | "windows"
  /** Versiones exactas para reproducibilidad. */
  versions: { bun: string; prisma: string }
  /** Ejecuta `next build` si no hay .next/standalone (por defecto true). */
  ensureBuild?: boolean
}

export interface PayloadResult {
  files: number
  bytes: number
  /** Bytes de node_modules podado (runtime deps). */
  nodeModulesBytes: number
  /** Paquetes copiados al node_modules del payload. */
  packages: string[]
}

// Raíces del node_modules de RUNTIME (walk transitivo deps+optionalDeps).
export const PAYLOAD_ROOTS = ["prisma", "@prisma/client", "zod"] as const

// Paquetes PROHIBIDOS en el payload (devDeps + UI de cliente compilada en el
// bundle del navegador + toolchain de build). Si aparecen → guard FALLA.
export const FORBIDDEN_PACKAGES = [
  "typescript",
  "eslint",
  "eslint-config-next",
  "playwright",
  "@playwright",
  "@playwright/test",
  "tailwindcss",
  "@tailwindcss/postcss",
  "tw-animate-css",
  "bun-types",
  "@types/react",
  "@types/react-dom",
  "cmdk",
  "lucide-react",
  "framer-motion",
  "recharts",
  "@dnd-kit",
  "@radix-ui",
  "@tanstack",
  "embla-carousel-react",
  "next-themes",
  "sonner",
  "vaul",
  "input-otp",
  "react-day-picker",
  "react-markdown",
  "react-hook-form",
  "@hookform",
  "react-resizable-panels",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "tailwindcss-animate",
  "date-fns",
  "z-ai-web-dev-sdk",
  "zustand",
  "hls.js",
  "mpegts.js",
  "next", // compilador: runtime = standalone trazado (decisión documentada)
  "react",
  "react-dom",
]

// Directorios/archivos que NO deben existir en el payload (datos/dev/secretos).
export const FORBIDDEN_SERVER_ENTRIES = [
  ".env",
  ".env.local",
  "db",
  "download",
  "test-results",
  "playwright-report",
  "blob-report",
  "dev.log",
  "server.log",
  "logs",
  "backups",
  "data",
  "upload",
  "uploads",
  "e2e",
  "tests",
  "docs",
  "skills",
  "ci-logs",
  ".git",
  ".github",
  "dist",
  ".tmp-buntest",
  "playwright.config.ts",
  "eslint.config.mjs",
]

// Archivos EXACTOS que deben existir (contrato con install.ts / systemd / NSSM).
export const REQUIRED_SERVER_FILES = [
  "package.json",
  "prisma/schema.prisma",
  "prisma/seed.ts",
  ".next/standalone/server.js",
  ".next/standalone/package.json",
  ".next/standalone/.next/static",
  ".next/standalone/node_modules/@prisma/client",
  "scripts/start.ts",
  "scripts/backup.ts",
  "scripts/restore.ts",
  "scripts/logs-purge.ts",
  "scripts/init-production.ts",
  "scripts/lib/env-file.ts",
  "scripts/lib/production-init.ts",
  "scripts/lib/prompt.ts",
  "src/lib/auth.ts",
  "src/lib/env.ts",
  "src/lib/validators.ts",
  "src/lib/backup.ts",
  "src/lib/media.ts",
  "mini-services/realtime-service/index.ts",
  "mini-services/realtime-service/node_modules/socket.io",
  "mini-services/stream-service/index.ts",
  "mini-services/stream-service/node_modules/node-media-server",
  "node_modules/prisma",
  "node_modules/@prisma/client",
  "node_modules/.prisma/client/default.js",
  "node_modules/.bin",
]

// Configs pequeñas (reparación con red / documentación de build) — kilobytes.
const SERVER_CONFIG_FILES = [
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "components.json",
  "bunfig.toml",
]

// Scripts de runtime (los que systemd/NSSM/manager ejecutan en producción).
const SERVER_SCRIPTS = [
  "scripts/start.ts",
  "scripts/backup.ts",
  "scripts/restore.ts",
  "scripts/logs-purge.ts",
  "scripts/media-gc.ts",
  "scripts/init-production.ts",
  "scripts/lib/env-file.ts",
  "scripts/lib/production-init.ts",
  "scripts/lib/prompt.ts",
]

// src/lib — SOLO los módulos importados por los scripts de runtime (mapa
// verificado: backup→{@prisma/client, media}; media→{env}; env→{zod};
// auth→{env}; validators→{zod}; production-init→{auth, env, validators}).
const SERVER_SRC_FILES = [
  "src/lib/auth.ts",
  "src/lib/env.ts",
  "src/lib/validators.ts",
  "src/lib/backup.ts",
  "src/lib/media.ts",
]

// Whitelist del standalone: NADA más (Next espeja el repo — sin esto el
// payload se llevaría db/, .env, download/, docs/, skills/…).
const STANDALONE_WHITELIST = [
  "server.js",
  "package.json",
  ".next",
  "node_modules",
  "public",
]

// Límites de guard (fallan ANTES de Tauri/NSIS — nunca un instalador roto).
export const PAYLOAD_LIMITS = {
  maxBytes: 700 * 1024 * 1024, // 700 MB (esperado ~400; margen 2×)
  maxFiles: 150_000,
  // NSIS MAX_PATH=260; prefijo corto C:\v\src-tauri\resources\server\ ≈ 33 →
  // 200 de holgura. Linux deb/AppImage: irrelevante (límites de kernel altos).
  maxRelativePath: 200,
  maxDepth: 16,
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(`PAYLOAD INVÁLIDO: ${message}`)
    this.name = "PayloadError"
  }
}

// ------------------------------------------------------------------ helpers

function log(step: string): void {
  console.log(`\n→ ${step}`)
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`)
}

/** Cuenta archivos/bytes de un árbol (sin seguir symlinks: cuentan 1 entrada). */
export function treeStats(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else {
        files++
        bytes += st.size
      }
    }
  }
  walk(root)
  return { files, bytes }
}

/** Copia desreferenciando symlinks (portabilidad Windows/NSIS). */
function copyTreeDeref(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, force: true, dereference: true })
}

// ------------------------------------------------------------------ 1. build

/** Garantiza .next/standalone (build de producción en el ENTORNO DE BUILD). */
export function ensureStandaloneBuild(root: string, ensureBuild = true): void {
  const standalone = join(root, ".next", "standalone", "server.js")
  if (existsSync(standalone)) {
    ok(".next/standalone ya compilado (build previo del entorno de build)")
    return
  }
  if (!ensureBuild) {
    throw new PayloadError("no hay .next/standalone/server.js y el build está desactivado")
  }
  log("Build standalone de producción (Next.js — en el entorno de build)")
  const r = spawnSync("bun", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: "file:./db/bundle-placeholder.db",
      AUTH_SECRET: "bundle-placeholder-secret-not-real-0123456789",
      REALTIME_TOKEN: "bundle-placeholder-token-not-real-012345",
    },
    timeout: 1_800_000,
  })
  if (r.status !== 0 || !existsSync(standalone)) {
    throw new PayloadError("next build falló o no produjo .next/standalone/server.js")
  }
  ok(".next/standalone compilado")
}

/** Garantiza Prisma Client generado (node_modules/.prisma/client). */
export function ensurePrismaClient(root: string): void {
  const marker = join(root, "node_modules", ".prisma", "client", "default.js")
  if (existsSync(marker)) {
    ok("Prisma Client ya generado (.prisma/client)")
    return
  }
  log("Generando Prisma Client (entorno de build)")
  const r = spawnSync("bun", ["x", "prisma", "generate"], { cwd: root, stdio: "inherit", timeout: 240_000 })
  if (r.status !== 0 || !existsSync(marker)) {
    throw new PayloadError("prisma generate falló — el payload necesita el client generado")
  }
  ok("Prisma Client generado")
}

// --------------------------------------------- 2. node_modules podado (walk)

/**
 * Podado del node_modules: copia SOLO los paquetes alcanzables desde `roots`
 * vía dependencies + optionalDependencies (nunca devDependencies ni
 * peerDependencies), filtrando los binarios opcionales por plataforma.
 * `.prisma` (client generado) se copia completo.
 */
export function pruneNodeModules(
  srcNM: string,
  dstNM: string,
  roots: readonly string[],
  platform: "linux" | "windows",
): { packages: string[]; bytes: number } {
  const srcPkg = (name: string): string => join(srcNM, ...name.split("/"))
  const pkgJson = (name: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(srcPkg(name), "package.json"), "utf8"))
    } catch {
      return null
    }
  }

  const queue = [...roots]
  const seen = new Set<string>()
  const copied: string[] = []

  mkdirSync(dstNM, { recursive: true })

  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    if (!existsSync(srcPkg(name))) continue // p.ej. binarios de otra plataforma
    seen.add(name)

    const json = pkgJson(name)
    if (!json) continue // paquete sin package.json: nada que copiar/resolver

    copyTreeDeref(srcPkg(name), join(dstNM, ...name.split("/")))
    copied.push(name)

    const walkDeps = (field: "dependencies" | "optionalDependencies"): void => {
      const deps = json[field]
      if (!deps || typeof deps !== "object") return
      for (const dep of Object.keys(deps as Record<string, string>)) {
        if (!existsSync(srcPkg(dep))) continue
        if (field === "optionalDependencies" && platformMismatch(dep, platform)) {
          continue // binario de otra plataforma (cross-compile)
        }
        queue.push(dep)
      }
    }
    walkDeps("dependencies")
    walkDeps("optionalDependencies")
  }

  // .prisma/client — generado (raíz especial: no está en ningún "dependencies")
  const dotPrisma = join(srcNM, ".prisma")
  if (existsSync(dotPrisma)) {
    copyTreeDeref(dotPrisma, join(dstNM, ".prisma"))
    copied.push(".prisma")
  }

  // .bin — SOLO bins del conjunto podado (bunx prisma). Symlinks recreados
  // como links (resolución relativa del shim intacta — ver copyBin).
  copyBin(srcNM, dstNM, ["prisma"], platform)

  let bytes = 0
  for (const p of copied) bytes += treeStats(join(dstNM, ...p.split("/"))).bytes
  bytes += treeStats(join(dstNM, ".bin")).bytes
  return { packages: copied, bytes }
}

/** ¿Nombre de paquete claramente de otra plataforma? (heurística conservadora) */
export function platformMismatch(pkgName: string, platform: "linux" | "windows"): boolean {
  const n = pkgName.toLowerCase()
  const has = (t: string): boolean => n.includes(t)
  const linuxish = has("linux") || has("musl") || has("debian") || has("alpine")
  const winish = has("win32") || has("windows") || has("msvc")
  const macish = has("darwin") || has("macos") || has("-mac-") || has("apple")
  if (platform === "linux") return winish || macish
  if (platform === "windows") return linuxish || macish
  return false
}

/**
 * Copia node_modules/.bin conservando SOLO los bins del conjunto podado.
 * Los symlinks se recrean COMO symlinks (target relativo intacto): si se
 * copiaran como archivo, la resolución relativa del shim (wasm/assets junto
 * al paquete real) se rompería — bug real encontrado por el smoke test.
 */
function copyBin(srcNM: string, dstNM: string, keep: string[], platform: "linux" | "windows"): void {
  const srcBin = join(srcNM, ".bin")
  const dstBin = join(dstNM, ".bin")
  if (!existsSync(srcBin)) return
  mkdirSync(dstBin, { recursive: true })
  for (const entry of readdirSync(srcBin, { withFileTypes: true })) {
    const base = entry.name.replace(/\.(exe|cmd|ps1|bat)$/i, "")
    if (!keep.includes(base)) continue
    const src = join(srcBin, entry.name)
    const dst = join(dstBin, entry.name)
    let st
    try {
      st = lstatSync(src)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(src)
      if (platform === "windows") {
        // cross-compile (windows desde linux): NSIS no admite symlinks y el
        // runner real de Windows trae shims nativos — recrear wrappers
        // portables que invocan el MISMO target relativo del link.
        writeFileSync(`${dst}.cmd`, `@echo off\r\nnode "%~dp0\\${target.replace(/\//g, "\\")}" %*\r\n`)
        writeFileSync(dst, `#!/bin/sh\nexec node "$(dirname "$0")/${target}" "$@"\n`)
        chmodSync(dst, 0o755)
      } else {
        symlinkSync(target, dst)
      }
    } else if (st.isFile()) {
      copyFileSync(src, dst)
      // assets hermanos del shim (p.ej. <bin>_*.wasm) si el paquete los puso en .bin
      for (const sib of readdirSync(srcBin)) {
        if (sib !== entry.name && sib.startsWith(`${entry.name}_`)) {
          copyFileSync(join(srcBin, sib), join(dstBin, sib))
        }
      }
    }
  }
}

// ------------------------------------------------- 3. createProductionPayload

/**
 * Crea el staging de producción EXPLÍCITO (ver cabecera del archivo).
 * Limpia serverDir, copia por whitelist, poda node_modules y valida.
 */
export function createProductionPayload(opts: PayloadOptions): PayloadResult {
  const { root, serverDir, platform } = opts

  log("Preparando staging de producción (payload explícito)")
  rmSync(serverDir, { recursive: true, force: true })
  mkdirSync(serverDir, { recursive: true })

  // --- .next/standalone (WHITELIST — Next espeja el repo: sin filtro metería
  // db/, .env, logs/, download/… dentro del instalador)
  log("Copiando .next/standalone (whitelist: server.js + node_modules + static + public)")
  const standaloneSrc = join(root, ".next", "standalone")
  if (!existsSync(join(standaloneSrc, "server.js"))) {
    throw new PayloadError("falta .next/standalone/server.js (¿ensureStandaloneBuild?)")
  }
  for (const entry of STANDALONE_WHITELIST) {
    const src = join(standaloneSrc, entry)
    if (!existsSync(src)) continue // p.ej. public podría no existir
    copyTreeDeref(src, join(serverDir, ".next", "standalone", entry))
  }
  // Variantes musl de sharp/@img (Alpine): inútiles en glibc (Ubuntu/Debian,
  // objetivo del instalador) y rompen linuxdeploy — "Could not find dependency:
  // libc.musl-x86_64.so.1" al empaquetar el AppImage GUI (evidencia real).
  // sharp resuelve la variante glibc (sharp-linux-x64) en runtime.
  let removedMusl = 0
  const stripMusl = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.name.includes("linuxmusl") || e.name.includes("musl-")) {
        rmSync(p, { recursive: true, force: true })
        removedMusl++
      } else if (e.isDirectory()) {
        stripMusl(p)
      }
    }
  }
  stripMusl(join(serverDir, ".next", "standalone", "node_modules"))
  if (removedMusl > 0) ok(`${removedMusl} variante(s) musl de sharp eliminadas (glibc = objetivo)`)
  // los manifests de .next viven en .next/standalone/.next (ya copiado vía ".next")
  ok("standalone copiado (sin espejo del repo, sin datos)")

  // --- código de runtime EXPLÍCITO
  log("Copiando código de runtime (scripts + src/lib + prisma + configs)")
  const copyFileIn = (rel: string): void => {
    mkdirSync(dirname(join(serverDir, rel)), { recursive: true })
    copyFileSync(join(root, rel), join(serverDir, rel))
  }
  for (const f of SERVER_SCRIPTS) copyFileIn(f)
  for (const f of SERVER_SRC_FILES) copyFileIn(f)
  for (const f of SERVER_CONFIG_FILES) {
    if (existsSync(join(root, f))) copyFileIn(f)
  }
  // prisma: schema + migrations + seed (migrate deploy offline del installer)
  mkdirSync(join(serverDir, "prisma"), { recursive: true })
  copyFileIn("prisma/schema.prisma")
  copyFileIn("prisma/seed.ts")
  copyTreeDeref(join(root, "prisma", "migrations"), join(serverDir, "prisma", "migrations"))
  // manifest raíz del servidor (package.json + lockfile = reproducible)
  copyFileSync(join(root, "package.json"), join(serverDir, "package.json"))
  copyFileSync(join(root, "bun.lock"), join(serverDir, "bun.lock"))
  ok("scripts/ prisma/ src/lib/ configs/ package.json")

  // --- mini-services (código + SUS node_modules — solo runtime deps)
  log("Copiando mini-services (código + node_modules runtime)")
  for (const svc of ["realtime-service", "stream-service"] as const) {
    const src = join(root, "mini-services", svc)
    const dst = join(serverDir, "mini-services", svc)
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (["node_modules", "bun.lock", "package.json", "index.ts", "auth.ts", "nms.d.ts"].includes(entry.name) === false) {
        continue
      }
      if (entry.isDirectory()) copyTreeDeref(join(src, entry.name), join(dst, entry.name))
      else copyFileSync(join(src, entry.name), join(dst, entry.name))
    }
    if (!existsSync(join(dst, "node_modules"))) {
      throw new PayloadError(`mini-services/${svc} sin node_modules — instala sus deps en el entorno de build`)
    }
  }
  ok("realtime-service + stream-service (socket.io, node-media-server)")

  // --- node_modules PODADO (runtime deps — walk transitivo)
  log("Podando node_modules (SOLO runtime: prisma CLI + @prisma/client + engines + zod)")
  const pruned = pruneNodeModules(
    join(root, "node_modules"),
    join(serverDir, "node_modules"),
    PAYLOAD_ROOTS,
    platform,
  )
  ok(
    `${pruned.packages.length} paquetes runtime (${(pruned.bytes / 1024 / 1024).toFixed(0)} MB) ` +
      `— roots: ${PAYLOAD_ROOTS.join(", ")}`,
  )

  // --- validación ESTRUCTURAL (contrato con install.ts)
  log("Validando estructura del payload (contrato install.ts)")
  for (const f of REQUIRED_SERVER_FILES) {
    if (!existsSync(join(serverDir, f))) {
      throw new PayloadError(`falta ${f} — el instalador lo requiere`)
    }
  }
  ok(`${REQUIRED_SERVER_FILES.length} archivos requeridos presentes`)

  const stats = treeStats(serverDir)
  ok(`payload: ${(stats.bytes / 1024 / 1024).toFixed(0)} MB · ${stats.files.toLocaleString()} archivos`)

  return { files: stats.files, bytes: stats.bytes, nodeModulesBytes: pruned.bytes, packages: pruned.packages }
}

// ------------------------------------------------------- 4. guards (VALIDAN)

/**
 * Guards que FALLAN el build ANTES de Tauri/NSIS/AppImage:
 * tamaño, nº de archivos, longitud/profundidad de rutas, paquetes prohibidos,
 * directorios de datos/desararrollo, symlinks y duplicados accidentales.
 *
 * Política de symlinks: en Linux se permiten SOLO links internos relativos
 * bajo node_modules/.bin (POSIX los resuelve; deb/AppImage los preservan).
 * En Windows (NSIS) NO se admite NINGÚN symlink: makensis y Git Bash no
 * pueden recrearlos de forma fiable.
 */
export function validatePayload(
  serverDir: string,
  opts: { ignoreSize?: boolean; platform?: "linux" | "windows" } = {},
): {
  files: number
  bytes: number
  maxPath: number
  maxDepth: number
} {
  const platform = opts.platform ?? "linux"
  const problems: string[] = []

  // 1) tamaño/nº archivos
  const stats = treeStats(serverDir)
  if (!opts.ignoreSize && stats.bytes > PAYLOAD_LIMITS.maxBytes) {
    problems.push(`tamaño ${(stats.bytes / 1024 / 1024).toFixed(0)} MB > límite ${(PAYLOAD_LIMITS.maxBytes / 1024 / 1024).toFixed(0)} MB`)
  }
  if (stats.files > PAYLOAD_LIMITS.maxFiles) {
    problems.push(`${stats.files} archivos > límite ${PAYLOAD_LIMITS.maxFiles}`)
  }

  // 2) entradas prohibidas (datos/secretos/árbol de desarrollo)
  for (const entry of FORBIDDEN_SERVER_ENTRIES) {
    if (entry === "MI NADA") continue
    if (existsSync(join(serverDir, entry))) {
      problems.push(`entrada prohibida presente: ${entry}`)
    }
  }

  let maxPath = 0
  let maxDepth = 0

  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      const rel = relative(serverDir, p)
      maxPath = Math.max(maxPath, rel.length)
      maxDepth = Math.max(maxDepth, depth)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        const allowed = platform === "linux" && rel.split(/[\\/]/)[0] === "node_modules" && rel.split(/[\\/]/)[1] === ".bin"
        if (!allowed) {
          problems.push(`symlink en el payload (no portable): ${rel}`)
        }
      } else if (st.isDirectory()) {
        walk(p, depth + 1)
      }
    }
  }
  walk(serverDir, 1)

  if (maxPath > PAYLOAD_LIMITS.maxRelativePath) {
    problems.push(`ruta relativa más larga ${maxPath} > ${PAYLOAD_LIMITS.maxRelativePath}`)
  }
  if (maxDepth > PAYLOAD_LIMITS.maxDepth) {
    problems.push(`profundidad máxima ${maxDepth} > ${PAYLOAD_LIMITS.maxDepth}`)
  }

  // 3) paquetes prohibidos en node_modules (devDeps/UI-compilada/toolchain)
  const nm = join(serverDir, "node_modules")
  const scopeDir = (scope: string): void => {
    const dir = join(nm, scope)
    if (!existsSync(dir)) return
    for (const sub of readdirSync(dir)) {
      const pkg = `${scope}/${sub}`
      if (FORBIDDEN_PACKAGES.includes(pkg)) problems.push(`paquete prohibido en runtime: ${pkg}`)
    }
  }
  for (const forbidden of FORBIDDEN_PACKAGES) {
    if (forbidden.startsWith("@")) {
      scopeDir(forbidden)
    } else if (existsSync(join(nm, forbidden))) {
      problems.push(`paquete prohibido en runtime: ${forbidden}`)
    }
  }

  // 4) duplicados accidentales de estructura (no confundir con el standalone
  //    trazado, que es intencional y autocontenido)
  for (const dup of [
    join(serverDir, "resources", "server"),
    join(serverDir, "node_modules", "node_modules"),
    join(serverDir, ".next", "standalone", "resources"),
    join(serverDir, ".next", "standalone", "db"),
    join(serverDir, ".next", "standalone", ".env"),
    join(serverDir, ".next", "standalone", "prisma"),
  ]) {
    if (existsSync(dup)) problems.push(`duplicado/árbol inesperado: ${relative(serverDir, dup)}`)
  }

  if (problems.length > 0) {
    // el mensaje INCLUYE los problemas (logs de CI legibles de un vistazo)
    throw new PayloadError(
      `${problems.length} problema(s) — el build FALLA antes de Tauri/NSIS:\n  · ${problems.join("\n  · ")}`,
    )
  }

  console.log(
    `✓ guards OK: ${(stats.bytes / 1024 / 1024).toFixed(0)} MB · ${stats.files.toLocaleString()} archivos · ` +
      `ruta máx ${maxPath} chars · profundidad máx ${maxDepth}`,
  )
  return { files: stats.files, bytes: stats.bytes, maxPath, maxDepth }
}

// ------------------------------------------------------- 5. manifiest helper

export interface PayloadManifest {
  product: string
  version: string
  platform: string
  architecture: string
  gitRev: string
  builtAt: string
  bunVersion: string
  payloadBunVersion: string
  offline: boolean
  withPrebuilt: boolean
  payloadFiles: number
  payloadBytes: number
  payloadNodeModulesBytes: number
  runtimePackages: string[]
  contents: Record<string, string>
}

export function buildManifest(args: {
  root: string
  platform: "linux" | "windows"
  version: string
  gitRev: string
  bunVersion: string
  payloadBunVersion: string
  payload: PayloadResult
  extra?: Record<string, string>
}): PayloadManifest {
  const pkg = JSON.parse(readFileSync(join(args.root, "package.json"), "utf8"))
  return {
    product: "ViewLBA-Server",
    version: args.version || pkg.version,
    platform: args.platform,
    architecture: "x64",
    gitRev: args.gitRev,
    builtAt: new Date().toISOString(),
    bunVersion: args.bunVersion,
    payloadBunVersion: args.payloadBunVersion,
    offline: true,
    withPrebuilt: true,
    payloadFiles: args.payload.files,
    payloadBytes: args.payload.bytes,
    payloadNodeModulesBytes: args.payload.nodeModulesBytes,
    runtimePackages: args.payload.packages,
    contents: {
      installer: args.platform === "windows" ? "viewlba-installer.exe" : "viewlba-installer",
      payload: "resources/server",
      runtime: "runtime/",
      ...(args.extra ?? {}),
    },
  }
}
