/**
 * Regresión ERROR C — "NSSM 2.24 mostrando su pantalla de uso"
 *
 * MISIÓN §0.8 + §0.9 + §4 + §5:
 *   - "No uses NSSM como dependencia final del producto Windows"
 *   - "No uses PowerShell como bandeja final de Windows"
 *   - "Crear installer/native/windows-service/"
 *   - "El servicio debe registrarse directamente con Windows SCM"
 *
 * Causa raíz: `deploy/windows/install.ps1:142-144` invoca
 *   `& $NssmBin stop $name` / `remove $name confirm` / `install $name $BunBin $entry`
 * Si `$name`, `$BunBin` o `$entry` están vacíos (caso edge), NSSM recibe
 * `nssm.exe stop` (sin subcomando válido) o `nssm.exe install` (sin nombre de
 * servicio) → NSSM 2.24 abre su usage screen GUI → cuelga el instalador.
 *
 * Sustitución canónica (misión §4): crear crate Rust
 * `installer/native/windows-service/` que se registra con SCM vía
 * `StartServiceCtrlDispatcher` + `RegisterServiceCtrlHandler`.
 *
 * **ESTE TEST DEBE FALLAR MIENTRAS LA IMPLEMENTACIÓN ACTUAL CONTINÚE.**
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoDir, walkAndCollect, REPO_ROOT } from "./_helpers"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

describe("Regresión ERROR C — NSSM 2.24 usage screen (misión §0.8/§4)", () => {
  test("installer/core/* NO debe invocar nssm.exe", () => {
    const files = readRepoDir("installer/core", /\.ts$/)
    for (const { path, content } of files) {
      expect(content).not.toMatch(/\bnssm(\.exe)?\b/i)
    }
  })

  test("deploy/windows/install.ps1 NO debe invocar NSSM sin args suficientes", () => {
    const ps1 = readRepoFile("deploy/windows/install.ps1")
    // Patrón prohibido: $NssmBin stop sin $name, o install sin name + path + entry
    expect(ps1).not.toMatch(/&\s*\$NssmBin\s+stop\s*(?=\||$)/im)
    expect(ps1).not.toMatch(/&\s*\$NssmBin\s+install\s*(?=\||$)/im)
  })

  test("deploy/windows/install.ps1 NO debe tener dependencia NSSM (prohibido §0.8)", () => {
    const ps1 = readRepoFile("deploy/windows/install.ps1")
    // Cualquier referencia a nssm.exe / NSSM en el deploy de Windows es
    // prohibida por §0.8 "No uses NSSM como dependencia final del producto Windows"
    expect(ps1).not.toMatch(/\bnssm\b/i)
  })

  test("installer/windows/viewlba-setup.nsi NO debe empaquetar nssm.exe como runtime", () => {
    const nsi = readRepoFile("installer/windows/viewlba-setup.nsi")
    expect(nsi).not.toMatch(/nssm/i)
  })

  test("installer/windows/tray/ NO debe contener PowerShell .ps1 (§5)", () => {
    const trayFiles = readRepoDir("installer/windows/tray", /\.ps1$/)
    expect(trayFiles.length).toBe(0)
  })

  test("DEBE existir installer/native/windows-service/ (misión §4)", () => {
    // Una vez implementado el service host Rust, este dir debe existir.
    // Mientras tanto, el test falla como recordatorio de la deuda.
    const nativeServicePath = join(REPO_ROOT, "installer/native/windows-service")
    expect(existsSync(nativeServicePath)).toBe(true)
    if (existsSync(nativeServicePath)) {
      const stat = statSync(nativeServicePath)
      expect(stat.isDirectory()).toBe(true)
    }
  })

  test("DEBE existir installer/native/windows-tray/ (misión §5)", () => {
    const nativeTrayPath = join(REPO_ROOT, "installer/native/windows-tray")
    expect(existsSync(nativeTrayPath)).toBe(true)
    if (existsSync(nativeTrayPath)) {
      const stat = statSync(nativeTrayPath)
      expect(stat.isDirectory()).toBe(true)
    }
  })

  test("ningún adapter del installer debe invocar nssm.exe", () => {
    const files = [
      ...readRepoDir("installer/windows", /\.ts$/),
      ...readRepoDir("installer/linux", /\.ts$/),
    ]
    for (const { path, content } of files) {
      expect(content).not.toMatch(/\bnssm(\.exe)?\b/i)
    }
  })
})
