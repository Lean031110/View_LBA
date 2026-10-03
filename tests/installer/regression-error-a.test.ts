/**
 * Regresión ERROR A — PowerShell ParserError:
 *   "Debe proporcionar una expresión de valor después del operador '='"
 *
 * MISIÓN §2 + §6:
 *   - "Eliminar completamente del NSIS/MSI: PowerShell para generar contraseña"
 *   - ".pwd.tmp generado mediante shell"
 *   - "passwords pasadas en cadenas de comandos"
 *
 * Causa raíz: `installer/windows/viewlba-setup.nsi:130` usa PowerShell con
 * triple nivel de escaping anidado (`'...'` NSIS → `"..."` PowerShell →
 * `''..''` PowerShell). Si el escape se rompe, PowerShell recibe
 * `$p =` (sin valor) y responde ParserError.
 *
 * **ESTE TEST DEBE FALLAR MIENTRAS LA IMPLEMENTACIÓN ACTUAL CONTINÚE.**
 * Cuando la Fase 2 elimine PowerShell del NSIS, el test pasará.
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoFileNoComments } from "./_helpers"

describe("Regresión ERROR A — PowerShell ParserError '=' (misión §2/§6)", () => {
  test("viewlba-setup.nsi NO debe generar contraseña vía PowerShell pipe", () => {
    // Lee sin comentarios para que las menciones en comments tipo
    // "NO PowerShell para password" no hagan falso match.
    const nsi = readRepoFileNoComments("installer/windows/viewlba-setup.nsi")
    // Patrón prohibido: powershell.exe ... -Command "$$p=..." con escape anidado
    // que rompe PowerShell cuando el parser recibe `$p =` sin valor.
    const forbidden = /powershell\.exe[^\n]*-Command[^\n]*\$\$p[^\n]*Set-Content/i
    expect(nsi).not.toMatch(forbidden)
  })

  test("viewlba-setup.nsi NO debe usar .pwd.tmp como pasadero de password", () => {
    const nsi = readRepoFileNoComments("installer/windows/viewlba-setup.nsi")
    expect(nsi).not.toMatch(/\.pwd\.tmp/)
  })

  test("viewlba-setup.nsi NO debe tener contraseña hardcoded fallback", () => {
    const nsi = readRepoFileNoComments("installer/windows/viewlba-setup.nsi")
    // "ViewLBA-CambioYa1" es un fallback hardcoded que viola §6 (secrets deben
    // generarse con RNG criptográfico). No puede haber fallback hardcodeado.
    expect(nsi).not.toMatch(/ViewLBA-CambioYa1/i)
  })

  test("viewlba-setup.nsi NO debe pasar adminPassword por FileWrite directo", () => {
    // Misión §6: "El archivo de configuración inicial no
    // debe guardar secretos en línea de comandos si existe una alternativa
    // más segura".
    const nsi = readRepoFileNoComments("installer/windows/viewlba-setup.nsi")
    expect(nsi).not.toMatch(/adminPassword[^,}]*\$AdminPassword/i)
  })

  test("installer/core/secrets.ts SÍ debe generar secretos con crypto RNG", () => {
    const secrets = readRepoFile("installer/core/secrets.ts")
    expect(secrets).toMatch(/randomBytes/)
    expect(secrets).toMatch(/generateSecret/)
  })

  test("installer/core/secrets.ts NO debe imprimir secretos a stdout/log", () => {
    const secrets = readRepoFile("installer/core/secrets.ts")
    // No debe haber console.log ni process.stdout.write que imprima secretos
    // (el helper envSecretsComplete explícitamente no expone valores).
    expect(secrets).not.toMatch(/console\.log.*secret/i)
    expect(secrets).not.toMatch(/process\.stdout.*secret/i)
  })
})
