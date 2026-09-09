/**
 * Build de producción PORTABLE (FASE 29 — Linux/Windows/macOS).
 *
 * Sustituye al pipeline shell `next build && cp -r …` (cp es POSIX-only):
 *   1. next build (standalone)
 *   2. copia portable de .next/static y public → .next/standalone (fs.cpSync)
 *
 * Uso: bun run build   (idéntico en cualquier OS)
 */
import { spawnSync } from "child_process"
import { cpSync, existsSync, rmSync, mkdirSync } from "fs"
import { join, resolve } from "path"

const ROOT = resolve(import.meta.dir, "..")

// ---- 1) next build ----------------------------------------------------------
const bunx = process.platform === "win32" ? "bunx.cmd" : "bunx"
const res = spawnSync(bunx, ["next", "build"], { cwd: ROOT, stdio: "inherit", env: { ...process.env } })
if (res.status !== 0) {
  console.error("✗ next build falló (código", res.status ?? "señal", ")")
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
