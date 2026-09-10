/**
 * Empaqueta el SERVIDOR (payload) del installer oficial.
 *
 * El installer NO duplica el servidor: este script ENSAMBLA el servidor
 * existente (repo) + su build + deps + runtime en un payload autosuficiente
 * → "instalación completamente offline".
 *
 * Salida (staging):
 *   dist/release/<platform>/ViewLBA-Server/
 *     viewlba-installer(.exe)   ← sidecar CLI compilado (bun build --compile)
 *     runtime/bun               ← runtime incluido (MIT) — el usuario NO instala bun
 *     runtime/bunx              ← alias
 *     resources/server/         ← código + node_modules (prod+prisma) + build
 *     (windows) runtime/nssm.exe
 *     manifest.json             ← versión, commit, plataforma, offline
 *
 * Uso:
 *   bun installer/package/bundle-server.ts [--platform=linux|windows]
 *        [--out=dist/release] [--no-build] [--bun-version=1.3.14]
 *
 * REGLAS: sin comandos POSIX (fs APIs + spawn de bun/zip via bun).
 * El build de Next se hace EN el staging (producto real, no copia dev).
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const OUT_BASE = arg("out") ?? join(ROOT, "dist", "release")
const PLATFORM = (arg("platform") ?? process.platform === "win32" ? (arg("platform") ?? "windows") : (arg("platform") ?? "linux")) as "linux" | "windows"
const WITH_BUILD = !flags().has("--no-build")
const BUN_VERSION = arg("bun-version") ?? cleanBunVersion() ?? "1.3.14"
const NSSM_VERSION = "2.24"

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
}
function flags(): Set<string> {
  return new Set(process.argv.map((a) => a.split("=")[0]))
}
function cleanBunVersion(): string | undefined {
  const v = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim()
  return v || undefined
}

/**
 * ⚠ El staging se construye FUERA del repo (tmp): si se construye dentro,
 * Next/Turbopack infiere la raíz de tracing desde el git root y ANIDA
 * .next/standalone espejando rutas absolutas. Fuera del repo el standalone
 * sale plano (como en CI). Al final se mueve a OUT_BASE.
 */
const stage = join(tmpdir(), "viewlba-bundle", PLATFORM, "ViewLBA-Server")
const finalStage = join(OUT_BASE, PLATFORM, "ViewLBA-Server")
const serverDir = join(stage, "resources", "server")
const runtimeDir = join(stage, "runtime")

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

// ---------------------------------------------------------------- 1. limpiar
STEP("Preparando staging")
rmSync(stage, { recursive: true, force: true })
mkdirSync(serverDir, { recursive: true })
mkdirSync(runtimeDir, { recursive: true })

// ---------------------------------------------------------------- 2. código
STEP("Copiando código del servidor (exclusiones estándar — nunca datos)")
const { copyDirFiltered } = await import("../core/fsx")
const copied = copyDirFiltered(ROOT, serverDir)
OK(`${copied} archivos → ${serverDir}`)

// ---------------------------------------------------------------- 3. deps (completas — build-capable)
// FULL install (dev+prod): el payload debe poder COMPILAR (next build
// necesita Tailwind/PostCSS de devDependencies) y migrar (prisma CLI).
// Mismo entorno que el repo → build garantizado; payload autosuficiente
// (offline) y repair-desde-código funcional en destino.
STEP("Instalando dependencias COMPLETAS (offline-capable, build-capable)")
try {
  run("bun", ["install", "--frozen-lockfile"], { cwd: serverDir })
  OK("node_modules completos instalados")
} catch {
  // frozen puede diferir; reintentar sin frozen
  run("bun", ["install"], { cwd: serverDir })
  OK("node_modules completos instalados (resolución normal)")
}

// Prisma CLI + engines: sanity (deben venir en el install completo —
// migrate deploy / generate sin red en el destino).
for (const pkg of ["prisma", "@prisma"]) {
  if (!existsSync(join(serverDir, "node_modules", pkg))) {
    console.error(`✗ falta node_modules/${pkg} tras bun install — payload incompleto`)
    process.exit(1)
  }
}
OK("Prisma CLI + engines presentes (migrate offline)")

// mini-services: deps propias (pequeñas)
for (const svc of ["realtime-service", "stream-service"]) {
  const dir = join(serverDir, "mini-services", svc)
  STEP(`Deps de ${svc}`)
  try {
    run("bun", ["install", "--frozen-lockfile"], { cwd: dir })
  } catch {
    run("bun", ["install"], { cwd: dir })
  }
}

// ---------------------------------------------------------------- 4. prisma client
STEP("Generando Prisma Client (en el staging)")
run("bun", ["x", "prisma", "generate"], { cwd: serverDir })

// ---------------------------------------------------------------- 5. build
if (WITH_BUILD) {
  STEP("Build standalone de producción (Next.js)")
  run("bun", ["run", "build"], { cwd: serverDir, env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "file:./db/bundle-placeholder.db", AUTH_SECRET: "bundle-placeholder-secret-not-real-0123456789", REALTIME_TOKEN: "bundle-placeholder-token-not-real-012345" } })
  OK(".next/standalone precompilado incluido")

  // PORTABILIDAD: next build crea `.next/node_modules` con symlinks/junctions
  // relativos (p. ej. @prisma/client-<hash> → ../../../node_modules/@prisma/
  // client). En Windows se copian como junctions ABSOLUTOS/rotos (visto en CI:
  // ENOENT al recorrer el árbol). Se DESREFERENCIAN → payload portable sin
  // links; el runtime usa .next/standalone/node_modules (copia real).
  STEP("Normalizando symlinks de .next/node_modules (portabilidad Windows)")
  const nextNodeModules = join(serverDir, ".next", "node_modules")
  let fixedLinks = 0
  const resolveLinks = (dir: string): void => {
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
      if (st.isSymbolicLink()) {
        // resolver ANTES de eliminar el link (realpath sigue el link vivo)
        let real: string | null = null
        let fileContent: Buffer | null = null
        try {
          if (statSync(p).isDirectory()) real = realpathSync(p)
          else if (statSync(p).isFile()) fileContent = readFileSync(p)
        } catch {
          real = null // link roto
        }
        rmSync(p, { force: true, recursive: true })
        if (real) {
          mkdirSync(p, { recursive: true })
          cpSync(real, p, { recursive: true, force: true })
          fixedLinks++
        } else if (fileContent) {
          writeFileSync(p, fileContent)
          fixedLinks++
        }
      } else if (st.isDirectory()) {
        resolveLinks(p)
      }
    }
  }
  if (existsSync(nextNodeModules)) {
    resolveLinks(nextNodeModules)
    OK(`${fixedLinks} symlink(s) desreferenciados; 0 links rotos`)
  }
} else {
  console.log("· build omitido (--no-build): el installer compilará en destino")
}

// ---------------------------------------------------------------- 6. runtime bun
STEP(`Descargando Bun ${BUN_VERSION} (${PLATFORM}) — runtime incluido`)
const bunUrl = PLATFORM === "linux" ? `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip` : `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`
const zipPath = join(stage, `.runtime-bun.zip`)
download(bunUrl, zipPath)
// unzip: usar el unzip de bun (Bun.zip? no) — usar python? No: `bun x extract-zip`?
// Sin comandos POSIX: leer el ZIP con la API de Bun (Bun.file + ZipReader no existe).
// Solución multiplataforma honesta: `tar -xf` NO lee zip en todas partes; en Linux
// `unzip` puede no existir. Bun expone `Bun.spawnSync("bunx", ["dezip"])`… no.
// → usamos el módulo interno de "node:zlib" no aplica a zip.
// PRAGMÁTICO y legal: bunx sirve para UNZIP vía paquete "yauzl"? Añadir dep no.
// Solución final: extraer con el comando del SO disponible (unzip/tar/powershell)
// documentado como dependencia de EMPAQUETADO (no del usuario final).
extractZip(zipPath, join(stage, ".runtime-bun"))
const extracted = findFile(join(stage, ".runtime-bun"), PLATFORM === "linux" ? "bun" : "bun.exe")
if (!extracted) throw new Error("bun no encontrado tras descomprimir")
copyFileSync(extracted, join(runtimeDir, PLATFORM === "linux" ? "bun" : "bun.exe"))
if (PLATFORM === "linux") {
  // bunx: copia (bun se comporta como bunx según argv[0])
  copyFileSync(join(runtimeDir, "bun"), join(runtimeDir, "bunx"))
}
rmSync(join(stage, ".runtime-bun"), { recursive: true, force: true })
rmSync(zipPath, { force: true })
OK(`runtime/bun (${(statSync(join(runtimeDir, PLATFORM === "linux" ? "bun" : "bun.exe")).size / 1024 / 1024).toFixed(0)} MB)`)

// ---------------------------------------------------------------- 7. nssm (windows)
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

// ---------------------------------------------------------------- 8. sidecar CLI
STEP("Compilando el sidecar del installer (bun build --compile)")
const target = PLATFORM === "windows" ? "bun-windows-x64" : undefined
const sidecarArgs = ["build", "--compile", "installer/cli/main.ts", "--outfile", join(stage, PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer")]
if (target) sidecarArgs.splice(2, 0, "--target", target)
run("bun", sidecarArgs, { cwd: ROOT })
OK(`sidecar: ${join(stage, PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer")}`)

// ---------------------------------------------------------------- 9. manifest
const gitRev = (() => {
  try {
    return spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: ROOT }).stdout?.trim() ?? "unknown"
  } catch {
    return "unknown"
  }
})()
const manifest = {
  product: "ViewLBA-Server",
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  platform: PLATFORM,
  gitRev,
  builtAt: new Date().toISOString(),
  offline: true,
  withPrebuilt: WITH_BUILD,
  bunVersion: BUN_VERSION,
  contents: {
    installer: PLATFORM === "windows" ? "viewlba-installer.exe" : "viewlba-installer",
    payload: "resources/server",
    runtime: "runtime/",
  },
}
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2))

// ---------------------------------------------------------------- 10. mover al destino final
STEP("Moviendo el staging al destino final")
rmSync(finalStage, { recursive: true, force: true })
mkdirSync(dirname(finalStage), { recursive: true })
try {
  renameSync(stage, finalStage)
} catch {
  // tmp y el repo pueden estar en filesystems distintos: copiar y limpiar
  cpSync(stage, finalStage, { recursive: true })
  rmSync(stage, { recursive: true, force: true })
}

// resumen + tamaños
STEP("Resumen")
function dirSize(p: string): number {
  let total = 0
  let st
  try {
    st = lstatSync(p)
  } catch {
    return 0 // entrada inaccesible (link roto/AV): no romper el empaquetado
  }
  if (!st.isDirectory()) return st.size
  let entries
  try {
    entries = readdirSync(p)
  } catch {
    return 0
  }
  for (const e of entries) total += dirSize(join(p, e))
  return total
}
const serverSize = dirSize(join(finalStage, "resources", "server"))
console.log(`   payload:  ${(serverSize / 1024 / 1024).toFixed(0)} MB`)
console.log(`   runtime:  ${(dirSize(join(finalStage, "runtime")) / 1024 / 1024).toFixed(0)} MB`)
console.log(`   staging:  ${finalStage}`)
console.log(`   manifest: ${JSON.stringify(manifest)}`)
OK("PAYLOAD LISTO")

// ---------------------------------------------------------------- helpers
function download(url: string, dest: string): void {
  console.log(`   ↓ ${url}`)
  const r = spawnSync("bun", ["-e", `await Bun.write(${JSON.stringify(dest)}, Bun.file(${JSON.stringify(url)}));`], {
    encoding: "utf8",
    timeout: 600_000,
  })
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
    for (const e of readdirSync(dir, { withFileTypes: true })) {
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
