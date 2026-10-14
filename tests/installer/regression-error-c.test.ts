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
import { readRepoFile, readRepoDir, walkAndCollect, REPO_ROOT, readRepoFileNoComments } from "./_helpers"
import { existsSync, statSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("Regresión ERROR C — NSSM 2.24 usage screen (misión §0.8/§4)", () => {
  test("installer/core/* NO debe invocar nssm.exe (sin NSSM como dependencia)", () => {
    const files = readRepoDir("installer/core", /\.ts$/)
    // Patrón de INVOCACIÓN real (no mención diagnóstica en strings/sugerencias):
    // - resolveNssm / $NssmBin / this.nssmPath / nssmPath / .run("nssm" / runner.run(nssm
    const invocationPattern = /(resolveNssm|nssmPath|NssmBin|this\.nssm|runner\.run\(\s*["'`]?nssm|\.run\(this\.nssm)/i
    for (const { path, content } of files) {
      expect(content).not.toMatch(invocationPattern)
    }
  })

  test("deploy/windows/install.ps1 NO debe invocar NSSM como gestor de servicios", () => {
    const ps1 = readRepoFile("deploy/windows/install.ps1")
    // Patrón: invocación real del binario NSSM
    expect(ps1).not.toMatch(/&\s*\$NssmBin\b/)
    expect(ps1).not.toMatch(/&\s*\$nssm\b/i)
    expect(ps1).not.toMatch(/Get-Command\s+nssm\b/i)
  })

  test("deploy/windows/manage.ps1 NO debe invocar NSSM", () => {
    const ps1 = readRepoFile("deploy/windows/manage.ps1")
    expect(ps1).not.toMatch(/&\s*\$Nssm\b/)
    expect(ps1).not.toMatch(/nssm\s+(start|stop|restart|status|install|remove|set)\b/i)
  })

  test("installer/windows/viewlba-setup.nsi NO debe empaquetar nssm.exe via File directive", () => {
    const nsi = readRepoFileNoComments("installer/windows/viewlba-setup.nsi")
    // Patrón: líneas que comienzan con 'File' que referencian nssm
    // (NO flaggea guards anti-NSSM como ${If} ${FileExists} ... nssm.exe)
    const lines = nsi.split(/\r?\n/).filter((l) => /^\s*File\b/im.test(l))
    for (const l of lines) {
      expect(l).not.toMatch(/nssm/i)
    }
  })

  test("installer/windows/tray/ NO debe contener PowerShell .ps1 (misión §5)", () => {
    const trayFiles = readRepoDir("installer/windows/tray", /\.ps1$/)
    expect(trayFiles.length).toBe(0)
  })

  test("DEBE existir installer/native/windows-service/ (misión §4)", () => {
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

  test("installer/native/windows-service/ DEBE tener Cargo.toml", () => {
    const cargoPath = join(REPO_ROOT, "installer/native/windows-service/Cargo.toml")
    expect(existsSync(cargoPath)).toBe(true)
    const cargo = readFileSync(cargoPath, "utf8")
    expect(cargo).toMatch(/\[package\]/)
    expect(cargo).toMatch(/name\s*=\s*"viewlba-service"/)
  })

  test("installer/native/windows-tray/ DEBE tener Cargo.toml", () => {
    const cargoPath = join(REPO_ROOT, "installer/native/windows-tray/Cargo.toml")
    expect(existsSync(cargoPath)).toBe(true)
    const cargo = readFileSync(cargoPath, "utf8")
    expect(cargo).toMatch(/\[package\]/)
    expect(cargo).toMatch(/name\s*=\s*"viewlba-tray"/)
  })

  test("installer/native/* NO debe DEPENDER de NSSM (invocaciones, no menciones)", () => {
    // El Rust source puede mencionar NSSM en comentarios (e.g. "NO NSSM")
    // pero NO debe invocar nssm.exe como dependencia funcional.
    // Patrones de INVOCACIÓN prohibidos:
    // - Command::new("nssm") o Command::new("nssm.exe")
    // - references a un path nssm binario
    const files = readRepoDir("installer/native", /\.rs$/)
    const invocationPattern = /(Command::new\(\s*["'`]nssm|nssmPath|nssm_bin)/i
    for (const { path, content } of files) {
      expect(content).not.toMatch(invocationPattern)
    }
  })

  test("installer/windows/adapter.ts NO debe invocar nssm.exe", () => {
    const adapter = readRepoFile("installer/windows/adapter.ts")
    // Patrón de invocación real
    expect(adapter).not.toMatch(/runner\.run\(\s*this\.nssmPath|runner\.run\(\s*["'`]nssm/i)
    // resolveNssm function aún puede existir temporalmente para retrocompat,
    // pero su invocación directa desde el adapter debería desaparecer
  })
})
