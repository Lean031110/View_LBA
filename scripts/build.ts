/**
 * Build de producción PORTABLE (FASE 29 — Linux/Windows/macOS).
 *
 * Sustituye al pipeline shell `next build && cp -r …` (cp es POSIX-only):
 *   1. next build (standalone)
 *   2. normaliza el standalone si Next anidó la salida (root de tracing
 *      inferido por git/monorepo → server.js espejado en subdirectorios);
 *   3. copia portable de .next/static y public → .next/standalone (fs.cpSync)
 *
 * Uso: bun run build   (idéntico en cualquier OS)
 */
import { spawnSync } from "child_process"
import { cpSync, existsSync, readdirSync, rmSync, mkdirSync } from "fs"
import { dirname, join, resolve } from "path"

const ROOT = resolve(import.meta.dir, "..")

// ---- 1) next build ----------------------------------------------------------
// `bun x` (no "bunx"/"bunx.cmd"): bun.exe es un ejecutable REAL multi-OS;
// "bunx.cmd" NO se puede lanzar con spawnSync en Windows sin shell, y el
// runtime incluido del installer solo lleva bun.exe (+ bunx.exe copia).
const res = spawnSync("bun", ["x", "next", "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env } })
if (res.status !== 0) {
  console.error("✗ next build falló (código", res.status ?? "señal", ")")
  if (res.error) console.error("  error de spawn:", res.error.message)
  process.exit(res.status ?? 1)
}

// ---- 2) ensamblar el standalone --------------------------------------------
const standalone = join(ROOT, ".next", "standalone")
const staticDir = join(ROOT, ".next", "static")
const publicDir = join(ROOT, "public")

if (!existsSync(standalone)) {
  console.error("✗ no se generó .next/standalone (¿output: 'standalone' en next.config.ts?)")
  process.exit(1)
}

// ---- 2b) normalización: Next puede anidar server.js bajo la raíz de tracing
// inferida (p. ej. construir dentro de dist/… del repo → git root). El
// standalone debe tener server.js EN LA RAÍZ (start.ts/systemd/NSSM lo exigen).
if (!existsSync(join(standalone, "server.js"))) {
  const nested = findNestedServerJs(standalone)
  if (nested) {
    const nestedRoot = dirname(nested)
    console.log(`· standalone anidado detectado (${relativeSafe(nestedRoot, standalone)}) — normalizando…`)
    for (const entry of readdirSync(nestedRoot)) {
      cpSync(join(nestedRoot, entry), join(standalone, entry), { recursive: true, force: true })
    }
    // quitar el árbol espejo (primer segmento del path anidado)
    const first = nestedRoot.slice(standalone.length + 1).split(/[\\/]/)[0]
    rmSync(join(standalone, first), { recursive: true, force: true })
  }
}
if (!existsSync(join(standalone, "server.js"))) {
  console.error("✗ server.js no quedó en la raíz de .next/standalone (root de tracing inferido fuera del proyecto)")
  console.error("  Solución: ejecuta el build desde la raíz del proyecto o fija outputFileTracingRoot")
  process.exit(1)
}

// static → standalone/.next/static
const targetStatic = join(standalone, ".next", "static")
rmSync(targetStatic, { recursive: true, force: true })
mkdirSync(join(standalone, ".next"), { recursive: true })
cpSync(staticDir, targetStatic, { recursive: true })

// public → standalone/public
const targetPublic = join(standalone, "public")
rmSync(targetPublic, { recursive: true, force: true })
cpSync(publicDir, targetPublic, { recursive: true })

console.log("✓ Build standalone completo (portable): .next/standalone")
console.log("  Arranque: bun scripts/start.ts  (NODE_ENV=production, PORT configurable)")

// ---- helpers ---------------------------------------------------------------
/** Busca un server.js anidado (profundidad ≤ 8) dentro del standalone. */
function findNestedServerJs(root: string, depth = 0): string | null {
  if (depth > 8) return null
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue
      const p = join(root, entry.name)
      if (entry.isFile() && entry.name === "server.js") return p
      if (entry.isDirectory()) {
        const found = findNestedServerJs(p, depth + 1)
        if (found) return found
      }
    }
  } catch {
    /* noop */
  }
  return null
}

function relativeSafe(from: string, to: string): string {
  return from === to ? "." : from.slice(to.length + 1) || from
}
