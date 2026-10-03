/**
 * Contrato B: ACLs de ProgramData para LocalService
 * ================================================
 *
 * MISIÓN §4 + §7:
 *   El servicio corre como NT AUTHORITY\LocalService.
 *   Cada carpeta de ProgramData debe tener permisos ESPECÍFICOS —
 *   NO copiar permisos idénticos a todas las carpetas.
 *
 * Matriz de permisos requerida:
 *   | Ruta          | SYSTEM | Administrators | LocalService | Users |
 *   |---------------|--------|----------------|--------------|-------|
 *   | config        | full   | full           | read         | (none)|
 *   | data/db       | full   | full           | read+write   | (none)|
 *   | data/media    | full   | full           | read+write   | (none)|
 *   | data/backups  | full   | full           | read+write   | (none)|
 *   | data/store    | full   | full           | read+write   | (none)|
 *   | logs          | full   | full           | read+write   | read  |
 *   | credentials   | full   | full           | (NONE)       | (none)| ← solo SYSTEM+Admins
 *   | run           | full   | full           | read+write   | (none)|
 *   | cache         | full   | full           | read+write   | (none)|
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - El WiX MSI tenga Permission elements diferenciados por carpeta
 *   - credentials/ NO tenga Permission para LocalService
 *   - Las carpetas write-intensive (db, media, logs, run, cache) SÍ tengan
 *     Permission para LocalService con GenericWrite
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoFileNoComments } from "./_helpers"

const WIX_PATH = "installer/windows-msi/viewlba.wxs"

describe("CONTRATO B: ACLs ProgramData diferenciadas para LocalService", () => {
  test("viewlba.wxs EXISTE", () => {
    const wix = readRepoFile(WIX_PATH)
    expect(wix.length).toBeGreaterThan(0)
  })

  test("CREDENCIALES: NO tiene Permission para LocalService (restrictiva)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    // Buscar el componente credentials y sus Permission
    const credSection = wix.match(/DirectoryRef Id="CREDENTIALS_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(credSection.length).toBeGreaterThan(0)
    // NO debe haber LocalService en la sección de credenciales
    expect(credSection).not.toMatch(/LocalService/i)
  })

  test("DB: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const dbSection = wix.match(/DirectoryRef Id="DB_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(dbSection.length).toBeGreaterThan(0)
    expect(dbSection).toMatch(/LocalService/i)
    expect(dbSection).toMatch(/GenericWrite/i)
  })

  test("MEDIA: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const mediaSection = wix.match(/DirectoryRef Id="MEDIA_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(mediaSection.length).toBeGreaterThan(0)
    expect(mediaSection).toMatch(/LocalService/i)
    expect(mediaSection).toMatch(/GenericWrite/i)
  })

  test("LOGS: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const logsSection = wix.match(/DirectoryRef Id="LOGS_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(logsSection.length).toBeGreaterThan(0)
    expect(logsSection).toMatch(/LocalService/i)
    expect(logsSection).toMatch(/GenericWrite/i)
  })

  test("RUN: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const runSection = wix.match(/DirectoryRef Id="RUN_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(runSection.length).toBeGreaterThan(0)
    expect(runSection).toMatch(/LocalService/i)
    expect(runSection).toMatch(/GenericWrite/i)
  })

  test("CACHE: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const cacheSection = wix.match(/DirectoryRef Id="CACHE_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(cacheSection.length).toBeGreaterThan(0)
    expect(cacheSection).toMatch(/LocalService/i)
    expect(cacheSection).toMatch(/GenericWrite/i)
  })

  test("CONFIG: tiene Permission para LocalService con GenericRead (NO Write)", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const configSection = wix.match(/DirectoryRef Id="CONFIG_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(configSection.length).toBeGreaterThan(0)
    expect(configSection).toMatch(/LocalService/i)
    // config debe ser read-only para LocalService (los secretos se escriben solo por SYSTEM+Admins durante install)
    expect(configSection).toMatch(/GenericRead/i)
    expect(configSection).not.toMatch(/GenericWrite/i)
  })

  test("BACKUPS: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const backupsSection = wix.match(/DirectoryRef Id="BACKUPS_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(backupsSection.length).toBeGreaterThan(0)
    expect(backupsSection).toMatch(/LocalService/i)
    expect(backupsSection).toMatch(/GenericWrite/i)
  })

  test("STORE: tiene Permission para LocalService con GenericWrite", () => {
    const wix = readRepoFileNoComments(WIX_PATH)
    const storeSection = wix.match(/DirectoryRef Id="STORE_DIR"[\s\S]*?<\/DirectoryRef>/)?.[0] ?? ""
    expect(storeSection.length).toBeGreaterThan(0)
    expect(storeSection).toMatch(/LocalService/i)
    expect(storeSection).toMatch(/GenericWrite/i)
  })
})
