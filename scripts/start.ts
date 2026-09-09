/**
 * Arranque PORTABLE del servidor de producción (FASE 29 — Linux/Windows).
 *
 * Antes: `NODE_ENV=production bun .next/standalone/server.js | tee server.log`
 * (prefijo de env y tee son POSIX-only). Ahora bun scripts/start.ts funciona
 * en cualquier SO:
 *   · NODE_ENV=production (por defecto; el gestor de servicios puede fijarlo)
 *   · PORT (default 3000)
 *   · stdout/stderr a consola → systemd/journald o NSSM los capturan
 *     (el logger estructurado escribe además LOG_DIR/app.log con rotación)
 *
 * Señales reenviadas al hijo (systemd/NSSM detienen limpio).
 */
import { spawn } from "child_process"
import { existsSync } from "fs"
import { join, resolve } from "path"

const ROOT = resolve(import.meta.dir, "..")
const SERVER = join(ROOT, ".next", "standalone", "server.js")

if (!existsSync(SERVER)) {
  console.error("✗ No hay build standalone (.next/standalone/server.js). Ejecuta: bun run build")
  process.exit(1)
}

process.env.NODE_ENV ||= "production"
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT ?? "3000" }

const child = spawn(process.execPath, [SERVER], { env, stdio: "inherit", cwd: ROOT })

const forward = (sig: NodeJS.Signals) => {
  child.kill(sig)
}
process.on("SIGTERM", () => forward("SIGTERM"))
process.on("SIGINT", () => forward("SIGINT"))

child.on("exit", (code, signal) => {
  // mismo código de salida del hijo (systemd/NSSM leen el estado)
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
