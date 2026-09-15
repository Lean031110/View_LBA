/**
 * Reap de hijos de spawnSync que quedaron VIVOS pese a que la llamada
 * devolvió (quirk de bun en Windows: los pipes del hijo cerraron ANTES
 * que el proceso — bug real de los builds 15.º-16.º de v3.2.0: un
 * bun.exe — el CLI de prisma — vivo con sus subprocesos schema-engine
 * mantenía colgada toda la cadena cmd /c → NSIS → Setup.exe durante
 * 20+ minutos, con la instalación SANA y completada).
 *
 * Sin dependencias: importable tanto desde scripts/ (repo) como desde
 * installer/ (sidecar compilado).
 */
import { spawnSync } from "node:child_process"

/**
 * Mata el hijo `pid` SI sigue vivo. Si ya murió (caso normal), no hace
 * nada (taskkill/process.kill fallan y se traga el error).
 *
 * Windows: `taskkill /PID <pid> /T /F` — mata el ÁRBOL COMPLETO del hijo
 * (p. ej. prisma CLI + schema-engine) de forma síncrona y dura.
 * POSIX: `process.kill(pid, SIGTERM)` (el árbol se reparenta a init).
 */
export function reapIfAlive(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 8000,
        windowsHide: true,
        stdin: "ignore",
        stdio: ["ignore", "pipe", "pipe"],
      } as never)
    } catch {
      /* ya murió / taskkill no disponible — no bloqueante */
    }
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    /* ya murió y fue reaped — caso normal */
  }
}
