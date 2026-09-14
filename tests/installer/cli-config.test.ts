/**
 * Tests del parseo de argumentos del CLI del instalador.
 *
 * REGRESIÓN v3.2.0 (bug real del primer build de release): el CLI solo
 * aceptaba `--config=archivo.json` (forma «=»), pero postinst (Linux) y el
 * NSIS (Windows) invocan `--config archivo.json` (forma ESPACIO, estándar).
 * Sin soporte, el camino quedaba como SUBCOMANDO desconocido → printHelp +
 * exit 1 → el postinst abortaba la instalación del .deb y el Setup.exe
 * abortaba el registro del servicio.
 *
 * Aquí se valida el parseo (sin instalar nada): con `--config <archivo
 * inexistente>` el CLI debe llegar a unattendedInstall y fallar con un
 * error de LECTURA (no con el usage), y el subcomando por defecto debe
 * seguir siendo «install». Spawn real, sin mocks.
 */
import { describe, test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"

const CLI = join(import.meta.dir, "..", "..", "installer", "cli", "main.ts")

interface CliResult {
  stdout: string
  stderr: string
  code: number | null
}

function runCli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    })
    const out: CliResult = { stdout: "", stderr: "", code: null }
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error("timeout del CLI"))
    }, timeoutMs)
    proc.stdout.on("data", (d: Buffer) => (out.stdout += d.toString("utf8")))
    proc.stderr.on("data", (d: Buffer) => (out.stderr += d.toString("utf8")))
    proc.on("close", (code) => {
      clearTimeout(timer)
      out.code = code
      resolve(out)
    })
    proc.on("error", reject)
  })
}

describe("parseo de --config (regresión v3.2.0: forma ESPACIO)", () => {
  test("--config <archivo> (espacio) se parsea como config, NO como subcomando", async () => {
    // Archivo inexistente: si el argumento se parsea como CONFIG, el CLI
    // entra a unattendedInstall y falla al LEER el archivo (mensaje de
    // error, NO el usage). Antes del fix: printHelp («uso:») + exit 1.
    const r = await runCli(["--config", "/tmp/viewlba-no-existe-0123456789.json"])
    expect(r.code).not.toBe(0)
    const all = r.stdout + r.stderr
    expect(all).not.toContain("uso:")
    expect(all).not.toContain("instalación desatendida\n  viewlba-installer --json")
    // unattendedInstall intentó leer el archivo → error de lectura honesto
    expect(all.length).toBeGreaterThan(0)
  })

  test("--config=<archivo> (forma «=») sigue funcionando igual", async () => {
    const r = await runCli(["--config=/tmp/viewlba-no-existe-0123456789.json"])
    expect(r.code).not.toBe(0)
    const all = r.stdout + r.stderr
    expect(all).not.toContain("uso:")
  })

  test("subcomando de gestión sigue intacto (help solo sin args válidos)", async () => {
    // Un subcomando DESCONOCIDO debe seguir mostrando el usage (comportamiento
    // previo conservado — la regresión era que un ARCHIVO cayera aquí).
    const r = await runCli(["subcomando-inventado-xyz"])
    expect(r.code).toBe(1)
    expect((r.stdout + r.stderr)).toContain("uso:")
  })

  test("--json <subcomando>: el subcomando NO se consume como valor (regresión del fix)", async () => {
    // `--json detect` es un flag BOOLEANO + subcomando: detect debe llegar a
    // runManagerJson (JSON en stdout) y NO caer al modo instalación sidecar
    // (que se queda esperando config por stdin y falla con waiting-config).
    const r = await runCli(["--json", "detect"], 20_000)
    const all = r.stdout + r.stderr
    expect(all).not.toContain("waiting-config")
    expect(all).toContain('"command":"detect"')
  })
})
