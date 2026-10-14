/**
 * Contrato M: Setup.exe bootstrapper
 * ===================================
 * El bootstrapper es un .exe PURO que solo ejecuta el MSI.
 * NO es un segundo instalador.
 *
 * Mision M: "Si NSIS se mantiene unicamente como bootstrapper,
 * el .exe debe seguir usando el icono oficial."
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - viewlba-setup.nsi sea un bootstrapper puro (no instale nada)
 *   - Use el icono oficial (viewlba.ico)
 *   - El workflow construya el bootstrapper
 *   - El artifact final incluya ambos .exe y .msi
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoFileNoComments } from "./_helpers"

const NSI_PATH = "installer/windows/viewlba-setup.nsi"
const WORKFLOW_PATH = ".github/workflows/build-windows-installer.yml"

describe("CONTRATO M: Setup.exe bootstrapper puro", () => {
  test("viewlba-setup.nsi existe", () => {
    const nsi = readRepoFile(NSI_PATH)
    expect(nsi.length).toBeGreaterThan(0)
  })

  test("USA el icono oficial (viewlba.ico, NO viejo Tauri icon)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).toMatch(/viewlba\.ico/i)
    // NO debe referenciar el viejo icono generico
    expect(nsi).not.toMatch(/installer\\gui\\src-tauri\\icons\\icon\.ico/i)
  })

  test("Ejecuta msiexec para lanzar el MSI", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).toMatch(/msiexec/i)
    expect(nsi).toMatch(/\/i/i)
  })

  test("NO copia payload (File /r prohibido — eso es del MSI)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    // El bootstrapper NO debe copiar archivos del payload
    expect(nsi).not.toMatch(/File\s+\/r/i)
    expect(nsi).not.toMatch(/Copy-Item.*payload/i)
  })

  test("NO registra servicio (eso es del MSI via ServiceInstall)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    // El bootstrapper NO debe registrar servicios
    expect(nsi).not.toMatch(/viewlba-service.*--install/i)
    expect(nsi).not.toMatch(/sc\s+create/i)
  })

  test("NO crea ProgramData (eso es del MSI)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).not.toMatch(/CreateDirectory.*ProgramData/i)
  })

  test("NO genera credenciales (eso es del sidecar via MSI)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).not.toMatch(/CREDENCIALES|adminPassword|\.pwd\.tmp/i)
  })

  test("Tiene version info (ProductName, FileVersion)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).toMatch(/VIAddVersionKey.*ProductName/i)
    expect(nsi).toMatch(/VIAddVersionKey.*FileVersion/i)
  })

  test("RequestExecutionLevel admin", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).toMatch(/RequestExecutionLevel\s+admin/i)
  })

  test("Single instance check (mutex)", () => {
    const nsi = readRepoFileNoComments(NSI_PATH)
    expect(nsi).toMatch(/CreateMutex|mutex|single.*instance/i)
  })

  test("Workflow construye el bootstrapper", () => {
    const workflow = readRepoFile(WORKFLOW_PATH)
    expect(workflow).toMatch(/bootstrapper|Setup\.exe|makensis|viewlba-setup\.nsi/i)
  })

  test("Artifact final incluye ambos .exe y .msi", () => {
    const workflow = readRepoFile(WORKFLOW_PATH)
    expect(workflow).toMatch(/\.msi/i)
    expect(workflow).toMatch(/\.exe/i)
  })
})
