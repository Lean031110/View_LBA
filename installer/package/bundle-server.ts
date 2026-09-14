/**
 * Empaqueta el SERVIDOR (payload) del installer oficial — V2: PAYLOAD DE PRODUCCIÓN.
 *
 * El installer NO duplica el servidor: este script ENSAMBLA el servidor
 * existente (repo) + su build + runtime en un payload autosuficiente
 * → "instalación completamente offline".
 *
 * DIFERENCIA con la V1 (que rompía NSIS/linuxdeploy):
 *   V1: copiaba el repo → `bun install` COMPLETO (dev+prod) → build en el
 *       staging → node_modules enteros en el payload = 1284 MB con cadenas
 *       node_modules anidadas (cmdk/@radix-ui/…, 176+ de profundidad) y
 *       rutas >260 que makensis no puede abrir.
 *   V2: BUILD DEPENDENCIES ≠ RUNTIME DEPENDENCIES. El build ocurre en el
 *       ENTORNO DE BUILD (repo con deps completas); el payload distribuido es
 *       EXPLÍCITO (ver installer/package/payload.ts): standalone trazado por
 *       Next + node_modules PODADO (prisma/@prisma/zod) + scripts de runtime.
 *       ~400 MB, sin anidamiento, sin devDeps, sin datos.
 *
 * Salida (staging):
 *   dist/release/<platform>/ViewLBA-Server/
 *     viewlba-installer(.exe)   ← sidecar CLI compilado (bun build --compile:
 *                                 la lógica de install va EMBEBIDA en el binario)
 *     runtime/bun               ← runtime incluido (MIT) — el usuario NO instala bun
 *     runtime/bunx              ← alias (argv[0])
 *     (windows) runtime/nssm.exe
 *     resources/server/         ← PAYLOAD DE PRODUCCIÓN (payload.ts)
 *     manifest.json             ← versión, commit, plataforma, tamaños, offline
 *
 * Uso:
 *   bun installer/package/bundle-server.ts [--platform=linux|windows]
 *        [--out=dist/release] [--version=X.Y.Z] [--bun-version=1.3.14]
 *        [--no-build] [--ignore-size-limits]
 *
 * REGLAS: sin comandos POSIX (fs APIs + spawn de bun/curl via bun).
 * La red se usa SOLO durante el BUILD (bun/nssm descargados aquí);
 * el instalador final funciona sin Internet.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync, cpSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  createProductionPayload,
  ensurePrismaClient,
  ensureStandaloneBuild,
  buildManifest,
  validatePayload,
  treeStats,
  type PayloadResult,
} from "./payload"

const ROOT = resolve_repo()
const OUT_BASE = arg("out") ?? join(ROOT, "dist", "release")
const PLATFORM = (arg("platform") ?? (process.platform === "win32" ? "windows" : "linux")) as "linux" | "windows"
const WITH_BUILD = !flags().has("--no-build")
const IGNORE_SIZE = flags().has("--ignore-size-limits")
// Runtime DISTRIBUIDO (versión exacta — reproducibilidad; no "latest").
const BUN_VERSION = arg("bun-version") ?? "1.3.14"
const NSSM_VERSION = "2.24"

function resolve_repo(): string {
  // src-tauri/resources puede clonar el repo dentro de sí (rounds previos);
  // resolver siempre al repo raíz REAL (donde está package.json + .git).
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "prisma", "schema.prisma"))) return dir
    dir = dirname(dir)
  }
  return dirname(fileURLToPath(import.meta.url))
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
}
function flags(): Set<string> {
  return new Set(process.argv.map((a) => a.split("=")[0]))
}

const STEP = (s: string) => console.log(`\n→ ${s}`)
const OK = (s: string) => console.log(`✓ ${s}`)

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", cwd: opts.cwd, env: opts.env, timeout: 1_800_000 })
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(" ")} falló:\n${(r.stderr || r.stdout || "").toString().slice(0, 3000)}`)
    process.exit(1)
  }
  return (r.stdout ?? "").toString()
}

// ---------------------------------------------------------------- 0. entorno
STEP("Verificando entorno de build (deps completas = aquí SÍ, en el payload NO)")
if (!existsSync(join(ROOT, "node_modules", "next"))) {
  console.error("✗ falta node_modules del repo — ejecuta `bun install --frozen-lockfile` primero")
  process.exit(1)
}
for (const svc of ["realtime-service", "stream-service"]) {
  if (!existsSync(join(ROOT, "mini-services", svc, "node_modules"))) {
    STEP(`Deps de mini-services/${svc} (entorno de build)`)
    try {
      run("bun", ["install", "--frozen-lockfile"], { cwd: join(ROOT, "mini-services", svc) })
    } catch {
      run("bun", ["install"], { cwd: join(ROOT, "mini-services", svc) })
    }
  }
}
ensureStandaloneBuild(ROOT, WITH_BUILD)
ensurePrismaClient(ROOT)

// ------------------------------------------------- 1. payload de producción
STEP("Creando el payload de producción (createProductionPayload)")
const stage = join(tmpdir(), "viewlba-bundle", PLATFORM, "ViewLBA-Server")
const finalStage = join(OUT_BASE, PLATFORM, "ViewLBA-Server")
const serverDir = join(stage, "resources", "server")
const runtimeDir = join(stage, "runtime")

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage), { recursive: true })

let payload: PayloadResult
try {
  payload = createProductionPayload({
    root: ROOT,
    serverDir,
    platform: PLATFORM,
    versions: { bun: BUN_VERSION, prisma: "6.x" },
    ensureBuild: false, // ya garantizado arriba (orden de pasos explícito)
  })
} catch (e) {
  console.error(`✗ ${(e as Error).message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 2. guards
STEP("Guards del payload (fallan ANTES de Tauri/NSIS — nunca un instalador roto)")
try {
  validatePayload(serverDir, { ignoreSize: IGNORE_SIZE, platform: PLATFORM })
} catch (e) {
  console.error(`✗ ${(e as Error).message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 3. runtime bun
STEP(`Descargando Bun ${BUN_VERSION} (${PLATFORM}) — runtime incluido`)
const bunUrl =
  PLATFORM === "linux"
    ? `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`
    : `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`
const zipPath = join(stage, `.runtime-bun.zip`)
download(bunUrl, zipPath)
extractZip(zipPath, join(stage, ".runtime-bun"))
const extracted = findFile(join(stage, ".runtime-bun"), PLATFORM === "linux" ? "bun" : "bun.exe")
if (!extracted) throw new Error("bun no encontrado tras descomprimir")
mkdirSync(runtimeDir, { recursive: true })
copyFileSync(extracted, join(runtimeDir, PLATFORM === "linux" ? "bun" : "bun.exe"))
if (PLATFORM === "linux") {
  // bunx: symlink (bun decide el modo por argv[0]; -a preserva links y
  // copyTree del installer también → 88 MB menos en el .deb/AppImage)
  symlinkSync("bun", join(runtimeDir, "bunx"))
}
rmSync(join(stage, ".runtime-bun"), { recursive: true, force: true })
rmSync(zipPath, { force: true })
OK(`runtime/bun (${(statSync(join(runtimeDir, PLATFORM === "linux" ? "bun" : "bun.exe")).size / 1024 / 1024).toFixed(0)} MB)`)

// ---------------------------------------------------------------- 4. nssm (windows)
if (PLATFORM === "windows") {
  STEP(`Descargando NSSM ${NSSM_VERSION} (gestor de servicios de Windows)`)
  const nssmUrl = `https://nssm.cc/release/nssm-${NSSM_VERSION}.zip`
  const nssmZip = join(stage, ".nssm.zip")
  download(nssmUrl, nssmZip)
  extractZip(nssmZip, join(stage, ".nssm"))
  const nssmExe = findFile(join(stage, ".nssm"), "nssm.exe", /win64/)
  if (!nssmExe) throw new Error("nssm.exe (win64) no encontrado tras descomprimir")
  copyFileSync(nssmExe, join(runtimeDir, "nssm.exe"))
  rmSync(join(stage, ".nssm"), { recursive: true, force: true })
  rmSync(nssmZip, { force: true })
  OK("runtime/nssm.exe incluido (licencia public domain de nssm.cc)")
}

// ---------------------------------------------------------------- 5. sidecar CLI
STEP("Compilando el sidecar del installer (bun build --compile — lógica embebida)")
// --target SOLO para cross-compile REAL: en el runner de Windows se compilaba
// con «--target bun-windows-x64» INNECESARIAMENTE y el binario resultante
// tenía los spawnSync rotos (whoami/cmd.exe/node/nssm devolvían vacío/error
// mientras bun.exe respondía — 13.º build de v3.2.0). El compile NATIVO se
// comporta como el sidecar de Linux (spawns correctos).
const needCrossTarget = PLATFORM === "windows" && process.platform !== "win32"
const target = needCrossTarget ? "bun-windows-x64" : undefined
const sidecarArgs = [
  "build",
  "--compile",
  "installer/cli/main.ts",
  "--outfile",
  join(stage, PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer"),
]
if (target) sidecarArgs.splice(2, 0, "--target", target)
run("bun", sidecarArgs, { cwd: ROOT })
OK(`sidecar: ${join(stage, PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer")}${target ? ` (cross-target ${target})` : " (nativo)"}`)

// ---------------------------------------------------------------- 6. manifest
const gitRev = (() => {
  try {
    return spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: ROOT }).stdout?.trim() ?? "unknown"
  } catch {
    return "unknown"
  }
})()
const buildBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "unknown"
const versionOverride = arg("version")
const manifest = buildManifest({
  root: ROOT,
  platform: PLATFORM,
  version: versionOverride ?? "",
  gitRev,
  bunVersion: buildBun,
  payloadBunVersion: BUN_VERSION,
  payload,
})
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2))

// ---------------------------------------------------------------- 7. destino final
STEP("Moviendo el staging al destino final")
rmSync(finalStage, { recursive: true, force: true })
mkdirSync(dirname(finalStage), { recursive: true })
try {
  renameSync(stage, finalStage)
} catch {
  // tmp y el repo pueden estar en filesystems distintos: copiar y limpiar
  cpSync(stage, finalStage, { recursive: true, force: true, dereference: true })
  rmSync(stage, { recursive: true, force: true })
}

// ---------------------------------------------------------------- resumen
STEP("Resumen")
const serverSize = treeStats(join(finalStage, "resources", "server"))
console.log(`   payload:  ${(serverSize.bytes / 1024 / 1024).toFixed(0)} MB (${serverSize.files.toLocaleString()} archivos)`)
console.log(`   runtime:  ${(treeStats(join(finalStage, "runtime")).bytes / 1024 / 1024).toFixed(0)} MB`)
const sidecarSize = statSync(join(finalStage, PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer")).size
console.log(`   sidecar:  ${(sidecarSize / 1024 / 1024).toFixed(0)} MB`)
console.log(`   staging:  ${finalStage}`)
console.log(`   manifest: ${JSON.stringify({ ...manifest, runtimePackages: `${manifest.runtimePackages.length} pkgs` })}`)
OK("PAYLOAD DE PRODUCCIÓN LISTO (offline, explícito, validado)")

// ---------------------------------------------------------------- helpers
function download(url: string, dest: string): void {
  console.log(`   ↓ ${url}`)
  const r = spawnSync(
    "bun",
    ["-e", `await Bun.write(${JSON.stringify(dest)}, Bun.file(${JSON.stringify(url)}));`],
    { encoding: "utf8", timeout: 600_000 },
  )
  if (r.status !== 0 || !existsSync(dest)) {
    // fallback curl (la red de empaquetado puede necesitar curl)
    const c = spawnSync("curl", ["-fsSL", "-o", dest, url], { encoding: "utf8", timeout: 600_000 })
    if (c.status !== 0 || !existsSync(dest)) {
      console.error(`✗ descarga falló: ${url}\n${(r.stderr || c.stderr || "").toString().slice(0, 500)}`)
      process.exit(1)
    }
  }
}

/** Extracción de ZIP dependiente del SO de EMPAQUETADO (no del usuario final). */
function extractZip(zip: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  const candidates: Array<[string, string[]]> = [
    ["unzip", ["-q", "-o", zip, "-d", dest]],
    ["python3", ["-m", "zipfile", "-e", zip, dest]],
    ["tar", ["-xf", zip, "-C", dest]],
    ["powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${zip}' '${dest}'`]],
  ]
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000 })
    if (r.status === 0) return
  }
  console.error(`✗ no hay extractor de ZIP disponible (unzip/python3/tar/powershell)`)
  process.exit(1)
}

/** Busca un archivo por nombre dentro del árbol (prefiere rutas que matcheen `prefer`). */
function findFile(root: string, name: string, prefer?: RegExp): string | null {
  let found: string | null = null
  let preferred: string | null = null
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === name) {
        found = p
        if (prefer && prefer.test(p)) preferred = p
      }
    }
  }
  walk(root)
  return preferred ?? found
}
