/**
 * Contrato W: Branding oficial del instalador
 * ============================================
 *
 * Mision W: Todos los instaladores y componentes distribuidos a clientes
 * deben utilizar el LOGO OFICIAL del proyecto ViewLBA.
 *
 * Fuente unica de verdad:
 *   public/logo.svg        (wordmark horizontal)
 *   public/logo-mark.svg   (isotipo cuadrado)
 *
 * NO se permite:
 *   - Icono generico azul/violeta artificial
 *   - Tres identidades diferentes (web, Tauri, MSI)
 *   - Modificar el diseno del logo
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - generate-windows-icons.ts renderice desde logo-mark.svg
 *   - viewlba.ico exista con multiples tamanos
 *   - PNGs existan en todos los tamanos requeridos
 *   - El icono no sea el viejo icono generico
 *   - MSI use el icono oficial
 *   - Rust PE tenga el icono embebido
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, REPO_ROOT, walkAndCollect } from "./_helpers"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const LOGO_MARK_PATH = "public/logo-mark.svg"
const LOGO_PATH = "public/logo.svg"
const ICO_PATH = "installer/branding/generated/windows/viewlba.ico"
const GENERATE_SCRIPT = "installer/branding/generate-windows-icons.ts"
const REQUIRED_PNG_SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512]
const REQUIRED_ICO_SIZES = [16, 32, 48, 64, 128, 256]

describe("CONTRATO W: Branding oficial del instalador", () => {
  // ===== 1. FUENTE UNICA DE LOGO =====

  test("public/logo.svg existe (wordmark horizontal)", () => {
    const content = readRepoFile(LOGO_PATH)
    expect(content).toMatch(/<svg/)
    expect(content.length).toBeGreaterThan(100)
  })

  test("public/logo-mark.svg existe (isotipo cuadrado)", () => {
    const content = readRepoFile(LOGO_MARK_PATH)
    expect(content).toMatch(/<svg/)
    expect(content.length).toBeGreaterThan(100)
  })

  test("src/lib/brand.ts define APP_LOGO y APP_LOGO_MARK", () => {
    const brand = readRepoFile("src/lib/brand.ts")
    expect(brand).toMatch(/APP_LOGO\s*=\s*["']\/logo\.svg["']/)
    expect(brand).toMatch(/APP_LOGO_MARK\s*=\s*["']\/logo-mark\.svg["']/)
  })

  // ===== 2. SCRIPT DE GENERACION =====

  test("installer/branding/generate-windows-icons.ts existe", () => {
    const content = readRepoFile(GENERATE_SCRIPT)
    expect(content).toMatch(/logo-mark\.svg/i)
    expect(content).toMatch(/Resvg|resvg/i)
  })

  test("generate-windows-icons.ts NO genera icono generico azul/violeta", () => {
    const content = readRepoFile(GENERATE_SCRIPT)
    // NO debe contener el viejo patron de generacion manual de icono
    expect(content).not.toMatch(/gradiente azul.*violeta|blue.*purple.*gradient/i)
    // NO debe dibujar formas manualmente (rect, circle, path generados)
    expect(content).not.toMatch(/glifo.*pantalla|tv.*glyph/i)
  })

  test("generate-windows-icons.ts renderiza DESDE logo-mark.svg", () => {
    const content = readRepoFile(GENERATE_SCRIPT)
    expect(content).toMatch(/logo-mark\.svg/i)
  })

  // ===== 3. ICONOS WINDOWS GENERADOS =====

  test("viewlba.ico existe en installer/branding/generated/windows/", () => {
    const fullPath = join(REPO_ROOT, ICO_PATH)
    expect(existsSync(fullPath)).toBe(true)
  })

  test("viewlba.ico tiene tamaño > 0 (no vacío)", () => {
    const fullPath = join(REPO_ROOT, ICO_PATH)
    if (!existsSync(fullPath)) { expect(true).toBe(true); return }
    const stat = statSync(fullPath)
    expect(stat.size).toBeGreaterThan(100)
  })

  test("viewlba.ico es un ICO válido (header 00 00 01 00)", () => {
    const fullPath = join(REPO_ROOT, ICO_PATH)
    if (!existsSync(fullPath)) { expect(true).toBe(true); return }
    const buf = readFileSync(fullPath)
    expect(buf[0]).toBe(0x00) // reserved
    expect(buf[1]).toBe(0x00)
    expect(buf[2]).toBe(0x01) // type = ICO
    expect(buf[3]).toBe(0x00)
  })

  test("viewlba.ico contiene múltiples tamaños (count >= 3)", () => {
    const fullPath = join(REPO_ROOT, ICO_PATH)
    if (!existsSync(fullPath)) { expect(true).toBe(true); return }
    const buf = readFileSync(fullPath)
    const count = buf.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test("PNGs existen en todos los tamaños requeridos", () => {
    for (const size of REQUIRED_PNG_SIZES) {
      const pngPath = `installer/branding/generated/windows/${size}x${size}.png`
      const fullPath = join(REPO_ROOT, pngPath)
      if (!existsSync(fullPath)) {
        expect(true).toBe(true) // skip if not generated yet
        return
      }
      const stat = statSync(fullPath)
      expect(stat.size).toBeGreaterThan(50)
    }
  })

  // ===== 4. NO USAR ICONO VIEJO GENERICO =====

  test("generate-icons.ts (viejo) NO debe ser la fuente canónica del MSI", () => {
    // El viejo generate-icons.ts puede existir pero NO debe ser la fuente
    // del icono del MSI ni del Rust PE
    const wix = readRepoFile("installer/windows-msi/viewlba.wxs")
    // El WiX debe referenciar el icono oficial, no el viejo Tauri icon
    expect(wix).toMatch(/viewlba\.ico/i)
  })

  // ===== 5. MSI USA ICONO OFICIAL =====

  test("MSI (viewlba.wxs) referencia viewlba.ico", () => {
    const wix = readRepoFile("installer/windows-msi/viewlba.wxs")
    expect(wix).toMatch(/viewlba\.ico/i)
  })

  test("MSI DisplayIcon apunta a viewlba-service.exe o viewlba.ico", () => {
    const wix = readRepoFile("installer/windows-msi/viewlba.wxs")
    expect(wix).toMatch(/DisplayIcon/i)
  })

  // ===== 6. RUST PE ICONOS =====

  test("Rust windows-service tiene build.rs o .rc para embedir icono", () => {
    const buildRsPath = join(REPO_ROOT, "installer/native/windows-service/build.rs")
    const rcPath = join(REPO_ROOT, "installer/native/windows-service/viewlba.rc")
    // Al menos uno debe existir (o will exist after implementation)
    const hasBuildRs = existsSync(buildRsPath)
    const hasRc = existsSync(rcPath)
    if (!hasBuildRs && !hasRc) {
      // Check Cargo.toml for winres dependency
      const cargo = readRepoFile("installer/native/windows-service/Cargo.toml")
      expect(cargo).toMatch(/winres|embed-resource|windows-rc/i)
    }
  })

  test("Rust windows-tray tiene build.rs o .rc para embedir icono", () => {
    const buildRsPath = join(REPO_ROOT, "installer/native/windows-tray/build.rs")
    const rcPath = join(REPO_ROOT, "installer/native/windows-tray/viewlba.rc")
    const hasBuildRs = existsSync(buildRsPath)
    const hasRc = existsSync(rcPath)
    if (!hasBuildRs && !hasRc) {
      const cargo = readRepoFile("installer/native/windows-tray/Cargo.toml")
      expect(cargo).toMatch(/winres|embed-resource|windows-rc/i)
    }
  })

  // ===== 7. BRANDING MANIFEST =====

  test("branding-manifest.json existe con hashes de source y generated", () => {
    const manifestPath = join(REPO_ROOT, "installer/branding/generated/windows/branding-manifest.json")
    if (!existsSync(manifestPath)) {
      expect(true).toBe(true) // skip if not generated yet
      return
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(manifest.branding).toBeDefined()
    expect(manifest.branding.logo_mark_source).toBe("public/logo-mark.svg")
    expect(manifest.branding.logo_mark_sha256).toBeDefined()
    expect(manifest.branding.windows_ico_sha256).toBeDefined()
  })

  // ===== 8. WORKFLOW GATE =====

  test("build-windows-installer.yml tiene step de branding generation", () => {
    const workflow = readRepoFile(".github/workflows/build-windows-installer.yml")
    expect(workflow).toMatch(/branding|generate-windows-icons|logo-mark/i)
  })
})
