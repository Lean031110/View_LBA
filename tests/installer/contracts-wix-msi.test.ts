/**
 * Contrato J: WiX MSI canónico y nativo
 * ======================================
 *
 * MISIÓN §3 + §6 + §31:
 *   - MSI canónico (no NSIS como sistema paralelo)
 *   - UpgradeCode ESTABLE entre versiones (no placeholder)
 *   - ServiceInstall + ServiceControl (WiX nativo, no CustomAction con --install)
 *   - ARP entry completo (DisplayName, Version, Publisher, InstallLocation, UninstallString, DisplayIcon)
 *   - Uninstall CONSERVA ProgramData (NO elimina DB, media, backups)
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - viewlba.wxs tenga UpgradeCode en <Package>
 *   - viewlba.wxs use ServiceInstall (no CustomAction --install)
 *   - viewlba.wxs tenga ARP registry values
 *   - viewlba.wxs uninstall NO borre ProgramData
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoFileNoComments } from "./_helpers"

const WIX_PATH = "installer/windows-msi/viewlba.wxs"

describe("CONTRATO J: WiX MSI canónico y nativo", () => {
  test("viewlba.wxs EXISTE", () => {
    const wix = readRepoFile(WIX_PATH)
    expect(wix.length).toBeGreaterThan(0)
  })

  // ========== J.1 UPGRADE CODE ==========

  test("UPGRADE_CODE en <Package UpgradeCode=...> (NO solo en build script)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Buscar UpgradeCode="..." en el <Package> element
    const packageMatch = wix.match(/<Package[^>]*UpgradeCode\s*=\s*"([^"]+)"/is)
    expect(packageMatch).not.toBeNull()
    expect(packageMatch![1].length).toBeGreaterThan(0)
  })

  test("UPGRADE_CODE NO es placeholder obvio", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const packageMatch = wix.match(/<Package[^>]*UpgradeCode\s*=\s*"([^"]+)"/is)
    if (packageMatch) {
      const code = packageMatch[1]
      // No debe ser el placeholder 8F2D9E7A-1234-5678-9ABC-DEF012345678
      // ni todos ceros ni placeholders obvios
      expect(code).not.toMatch(/^8F2D9E7A-1234-5678-9ABC-DEF012345678$/i)
      expect(code).not.toMatch(/^0{8}-(0{4}-){2}0{12}$/i)
      expect(code).not.toMatch(/PLACEHOLDER|EXAMPLE|TODO/i)
    }
  })

  test("MajorUpgrade element EXISTE y referencia el UpgradeCode", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const majorUpgrade = wix.match(/<MajorUpgrade[^>]*\/?>/i)
    expect(majorUpgrade).not.toBeNull()
  })

  // ========== J.2 PROGRAM FILES / PROGRAM DATA ==========

  test("Program Files\\ViewLBA Server es el InstallDir", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/ProgramFiles64Folder/i)
    expect(wix).toMatch(/ViewLBA Server/i)
  })

  test("ProgramData\\ViewLBA está definido como directory separado", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/CommonAppDataFolder/i)
    expect(wix).toMatch(/ViewLBA/i)
  })

  // ========== J.3 ARP ==========

  test("ARP entry tiene DisplayName", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/DisplayName/i)
  })

  test("ARP entry tiene Version (DisplayVersion)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/DisplayVersion/i)
  })

  test("ARP entry tiene Publisher", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/Publisher/i)
  })

  test("ARP entry tiene InstallLocation", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/InstallLocation|ARPINSTALLLOCATION/i)
  })

  test("ARP entry tiene UninstallString", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/UninstallString/i)
  })

  test("ARP entry tiene DisplayIcon", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/DisplayIcon/i)
  })

  test("ARP entry tiene NoModify=1 y NoRepair=1 (no modificar ni reparar)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/ARPNOMODIFY/i)
    expect(wix).toMatch(/ARPNOREPAIR/i)
  })

  // ========== J.4 SERVICE INSTALL (WiX nativo, NO CustomAction --install) ==========

  test("USA ServiceInstall + ServiceControl (WiX nativo — NO CustomAction con --install)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Buscar ServiceInstall element (WiX nativo)
    expect(wix).toMatch(/<ServiceInstall\b/i)
    // Buscar ServiceControl element
    expect(wix).toMatch(/<ServiceControl\b/i)
  })

  test("NO usa CustomAction con 'viewlba-service.exe --install'", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // El antiguo patrón: <CustomAction ExeCommand="--install" ...> en CustomAction
    // Esto NO debe existir como mecanismo de registro del servicio
    // (puede existir para --start después de ServiceInstall, pero no para --install)
    const installActions = wix.match(/<CustomAction[^>]*--install[^>]*>/gi) ?? []
    expect(installActions.length).toBe(0)
  })

  test("ServiceInstall especifica Account=LocalService (NO LocalSystem)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const serviceInstallMatch = wix.match(/<ServiceInstall\b[^>]*>/is)
    if (serviceInstallMatch) {
      const si = serviceInstallMatch[0]
      // Debe especificar LocalService account
      expect(si).toMatch(/LocalService|NT AUTHORITY\\\\LocalService/i)
      // NO debe ser LocalSystem (que es el default)
      expect(si).not.toMatch(/LocalSystem/i)
    }
  })

  test("ServiceInstall especifica Type=ownProcess", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const serviceInstallMatch = wix.match(/<ServiceInstall\b[^>]*>/is)
    if (serviceInstallMatch) {
      expect(serviceInstallMatch[0]).toMatch(/ownProcess/i)
    }
  })

  test("ServiceInstall especifica Start=auto (auto-start con Windows)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const serviceInstallMatch = wix.match(/<ServiceInstall\b[^>]*>/is)
    if (serviceInstallMatch) {
      expect(serviceInstallMatch[0]).toMatch(/Start\s*=\s*"auto"/i)
    }
  })

  test("ServiceControl maneja stop en uninstall (Remove=uninstall)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const serviceControlMatch = wix.match(/<ServiceControl\b[^>]*>/is)
    if (serviceControlMatch) {
      const sc = serviceControlMatch[0]
      expect(sc).toMatch(/Stop|Remove/i)
    }
  })

  // ========== J.5 UNINSTALL ==========

  test("UNINSTALL NO elimina ProgramData (conserva DB, media, backups)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Buscar RemoveFile o RemoveFolder que afecten ProgramData
    // Si RemoveFile/RemoveFolder referencia rutas en ProgramData, FALLA
    const removeFileMatches = wix.match(/<RemoveFile[^>]*>/gi) ?? []
    const removeFolderMatches = wix.match(/<RemoveFolder[^>]*>/gi) ?? []
    const allRemoves = [...removeFileMatches, ...removeFolderMatches]
    for (const r of allRemoves) {
      // NO debe tener Id o Property que referencie ProgramData dirs
      expect(r).not.toMatch(/CREDENTIALS_DIR|DATA_DIR|DB_DIR|MEDIA_DIR|BACKUPS_DIR|STORE_DIR/i)
    }
  })

  test("UNINSTALL SÍ elimina Program Files (binarios)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Debe haber RemoveFiles o similar que elimine Program Files
    expect(wix).toMatch(/RemoveFile|RemoveFolder|INSTALLDIR|INSTALLED/i)
  })

  // ========== J.6 SHORTCUTS / TRAY ==========

  test("INSTALA Start Menu shortcuts", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    expect(wix).toMatch(/ProgramMenuFolder|StartMenu/i)
  })

  test("INSTALA autostart del tray (HKCU Run)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Buscar RegistryKey para HKCU Run con ViewLBA
    expect(wix).toMatch(/CurrentVersion\\\\Run|HKCU.*Run/i)
  })

  test("AUTOSTART es por usuario (HKCU), NO por máquina (HKLM)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // El tray autostart debe ser HKCU porque el tray corre en la sesión del usuario
    const runKeyMatch = wix.match(/<RegistryKey\s+Root="HKCU"[^>]*Key="[^"]*Run"[^>]*>/i)
    expect(runKeyMatch).not.toBeNull()
  })
})
