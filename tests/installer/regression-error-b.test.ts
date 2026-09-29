/**
 * Regresión ERROR B — "FIND: formato de parámetros incorrecto"
 *
 * MISIÓN §7 + §0.7:
 *   - "Nunca usar: sc query ... | find ... para decidir si un servicio funciona"
 *   - "No uses pipelines de CMD para comprobar estados críticos"
 *
 * Causa raíz: `installer/windows/viewlba-setup.nsi:183` ejecuta
 *   `cmd /c "sc query ${SERVICE_APP} | find RUNNING > nul"`
 *
 * El `find` de Windows (find.exe, NO grep) interpreta:
 *   - Argumentos empezando con `/` como switches → error si se confunde
 *   - Sin comillas, argumentos especiales rompen el parser
 *   - Mensaje "Formato de parámetros incorrecto" se imprime a stderr,
 *     no a stdout, y el exit code puede ser 1 (falso negativo de servicio caído)
 *
 * Sustitución canónica (misión §7): el sidecar consulta SCM vía Win32
 * API o PowerShell `Get-Service` ENCAPSULADO en el adapter TS, NO en el NSIS.
 *
 * **ESTE TEST DEBE FALLAR MIENTRAS LA IMPLEMENTACIÓN ACTUAL CONTINÚE.**
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoDir } from "./_helpers"

describe("Regresión ERROR B — FIND formato de parámetros incorrecto (misión §7)", () => {
  test("viewlba-setup.nsi NO debe usar 'sc query | find' para validar servicio", () => {
    const nsi = readRepoFile("installer/windows/viewlba-setup.nsi")
    const forbidden = /sc\s+query[^\n]*\|\s*find\b/i
    expect(nsi).not.toMatch(forbidden)
  })

  test("viewlba-setup.nsi NO debe usar 'find RUNNING' sin comillas", () => {
    // Sin comillas, `find RUNNING` puede ser interpretado como switch si
    // el input contiene caracteres especiales.
    const nsi = readRepoFile("installer/windows/viewlba-setup.nsi")
    expect(nsi).not.toMatch(/find\s+RUNNING/i)
  })

  test("ningún archivo del installer/ debe contener 'sc query ... | find'", () => {
    const files = [
      ...readRepoDir("installer", /\.nsi$/),
      ...readRepoDir("installer", /\.ts$/),
      ...readRepoDir("installer", /\.ps1$/),
      ...readRepoDir("deploy", /\.ps1$/),
      ...readRepoDir("deploy", /\.sh$/),
    ]
    for (const { path, content } of files) {
      expect(content).not.toMatch(/sc\s+query[^\n]*\|\s*find\b/i)
    }
  })

  test("ningún archivo del installer/ debe usar cmd /c para envolver consultas de servicio", () => {
    // Patrón: cmd /c "sc query ... | find ..." o similar
    const files = [
      ...readRepoDir("installer", /\.nsi$/),
      ...readRepoDir("installer", /\.ts$/),
      ...readRepoDir("deploy", /\.ps1$/),
    ]
    for (const { path, content } of files) {
      // cmd /c con "sc query" en cualquier lado es el patrón prohibido
      expect(content).not.toMatch(/cmd\s*\/c[^\n]*sc\s+query/i)
    }
  })

  test("installer/core/health.ts SÍ debe tener lógica de health estructurada", () => {
    const health = readRepoFile("installer/core/health.ts")
    // Misión §0.10: el health debe confirmar application + database + storage
    // + realtime + stream
    expect(health).toMatch(/healthChecks|waitForHealth/i)
  })
})
