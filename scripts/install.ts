/**
 * Instalador multiplataforma (FASE 31) — ENTRADA DE COMPATIBILIDAD.
 *
 * Desde la misión del installer oficial, TODA la lógica vive en
 * `installer/` (core + adapters + cli) y este archivo SOLO delega en
 * `installer/cli/main.ts` — una única implementación, cero duplicación.
 *
 * Superficie conservada (flags):
 *   bun scripts/install.ts [--email=a@b.c] [--password=X] [--demo|--no-demo]
 *                          [--port=3000] [--timezone=America/Havana]
 *                          [--no-build] [--offline] [--dir=/ruta]
 *
 * Gestión posterior: bun installer/cli/main.ts {services|health|logs|backup|…}
 * La lógica reutilizada (initializeProduction, preflight, .env, rollback)
 * no cambió de sitio semántico: sigue siendo la misma, ahora compartida.
 */
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(PROJECT_ROOT, "installer", "cli", "main.ts")

// bun respeta la entrada de datos del terminal (stdio inherit) y propaga
// SIGINT/SIGTERM naturalmente; el CLI propio aplica el protocolo de
// finalización (closeStdin + watchdog) internamente.
const result = spawnSync(process.execPath, [CLI, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
})

process.exit(result.status ?? (result.error ? 1 : 0))
