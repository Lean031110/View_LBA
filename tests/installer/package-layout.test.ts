/**
 * Tests de RESOLUCIÓN DE PAQUETE (modo binario) del installer oficial.
 *
 * El instalador empaquetado corre desde tres layouts distintos:
 *  · AppImage CLI (appimage.sh):  <exeDir>/{viewlba-installer,resources/server,runtime}
 *  · NSIS Windows (Tauri):        <install>/resources/... junto al exe
 *  · deb/AppImage GUI (Tauri):    bin en usr/bin, recursos en usr/lib/<x>
 *    (el nombre del producto varía → el core ESCANEA ../lib/*)
 *  · override: VIEWLBA_PAYLOAD_DIR (la GUI lo inyecta desde resource_dir()).
 *
 * Además: findBundledBun (4 rutas contrato) y resolveNssm multi-root
 * (instalado → paquete → PATH) — el bug real: preflight FALLABA en Windows
 * limpio porque el adapter nunca recibía el NSSM incluido.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePackageRootFrom, findBundledBun } from "../../installer/core/install"
import { resolveNssm } from "../../installer/windows/adapter"

let tmp: string
let savedEnv: string | undefined

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-package-layout-"))
  savedEnv = process.env.VIEWLBA_PAYLOAD_DIR
  delete process.env.VIEWLBA_PAYLOAD_DIR
})
afterAll(() => {
  if (savedEnv === undefined) delete process.env.VIEWLBA_PAYLOAD_DIR
  else process.env.VIEWLBA_PAYLOAD_DIR = savedEnv
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

/** Crea <root>/resources/server/package.json (payload mínimo). */
function mkPayload(root: string): string {
  mkdirSync(join(root, "resources", "server"), { recursive: true })
  writeFileSync(join(root, "resources", "server", "package.json"), "{}")
  return root
}

// ---------- resolvePackageRootFrom ----------
describe("resolvePackageRootFrom (modo binario)", () => {
  test("NSIS/AppImage CLI: payload junto al exe → exeDir", () => {
    const exeDir = mkPayload(join(tmp, "nsis-like", "install"))
    expect(resolvePackageRootFrom(exeDir)).toBe(exeDir)
  })

  test("AppImage CLI: runtime/bun junto al exe (sin resources) → exeDir", () => {
    const exeDir = join(tmp, "appimage-cli", "mount")
    mkdirSync(join(exeDir, "runtime"), { recursive: true })
    writeFileSync(join(exeDir, "runtime", "bun"), "#!/bin/sh")
    expect(resolvePackageRootFrom(exeDir)).toBe(exeDir)
  })

  test("Tauri deb/AppImage GUI: bin en usr/bin, recursos en usr/lib/<producto> (escaneo)", () => {
    // el nombre del producto lo elige Tauri — NO debe importar
    const root = join(tmp, "tauri-deb")
    mkPayload(join(root, "usr", "lib", "viewlba-server"))
    const exeDir = join(root, "usr", "bin")
    mkdirSync(exeDir, { recursive: true })
    expect(resolvePackageRootFrom(exeDir)).toBe(join(root, "usr", "lib", "viewlba-server"))
  })

  test("Tauri con otro nombre de producto (con espacios) también se encuentra", () => {
    const root = join(tmp, "tauri-deb-2")
    mkPayload(join(root, "usr", "lib", "ViewLBA Server"))
    const exeDir = join(root, "usr", "bin")
    mkdirSync(exeDir, { recursive: true })
    expect(resolvePackageRootFrom(exeDir)).toBe(join(root, "usr", "lib", "ViewLBA Server"))
  })

  test("VIEWLBA_PAYLOAD_DIR (GUI Tauri) manda sobre todo", () => {
    const exeDir = mkPayload(join(tmp, "env-case", "exe"))
    const envRoot = mkPayload(join(tmp, "env-case", "from-gui"))
    process.env.VIEWLBA_PAYLOAD_DIR = envRoot
    try {
      expect(resolvePackageRootFrom(exeDir)).toBe(envRoot)
    } finally {
      delete process.env.VIEWLBA_PAYLOAD_DIR
    }
  })

  test("exeDir junto al exe GANA sobre el escaneo ../lib (orden contrato)", () => {
    const root = join(tmp, "order")
    mkPayload(join(root, "usr", "lib", "product"))
    const exeDir = mkPayload(join(root, "usr", "bin"))
    expect(resolvePackageRootFrom(exeDir)).toBe(exeDir)
  })

  test("sin payload en ninguna parte → exeDir (fallback honesto)", () => {
    const exeDir = join(tmp, "alone", "bin")
    mkdirSync(exeDir, { recursive: true })
    expect(resolvePackageRootFrom(exeDir)).toBe(exeDir)
  })
})

// ---------- findBundledBun ----------
describe("findBundledBun (rutas de los 4 layouts)", () => {
  test("runtime/bun (AppImage CLI)", () => {
    const root = join(tmp, "bun-cli")
    mkdirSync(join(root, "runtime"), { recursive: true })
    writeFileSync(join(root, "runtime", "bun"), "bin")
    expect(findBundledBun(root)).toBe(join(root, "runtime", "bun"))
  })

  test("runtime/bun.exe", () => {
    const root = join(tmp, "bun-exe")
    mkdirSync(join(root, "runtime"), { recursive: true })
    writeFileSync(join(root, "runtime", "bun.exe"), "bin")
    expect(findBundledBun(root)).toBe(join(root, "runtime", "bun.exe"))
  })

  test("resources/runtime/bun (deb/AppImage GUI de Tauri)", () => {
    const root = join(tmp, "bun-tauri")
    mkdirSync(join(root, "resources", "runtime"), { recursive: true })
    writeFileSync(join(root, "resources", "runtime", "bun"), "bin")
    expect(findBundledBun(root)).toBe(join(root, "resources", "runtime", "bun"))
  })

  test("resources/runtime/bun.exe (NSIS de Windows — bug fix)", () => {
    const root = join(tmp, "bun-nsis")
    mkdirSync(join(root, "resources", "runtime"), { recursive: true })
    writeFileSync(join(root, "resources", "runtime", "bun.exe"), "bin")
    expect(findBundledBun(root)).toBe(join(root, "resources", "runtime", "bun.exe"))
  })

  test("sin runtime → undefined", () => {
    expect(findBundledBun(join(tmp, "bun-none"))).toBeUndefined()
  })
})

// ---------- resolveNssm ----------
describe("resolveNssm (multi-root: instalado → paquete → PATH)", () => {
  test("raíz instalada: <install>/app/runtime/nssm.exe", () => {
    const installRoot = join(tmp, "nssm-installed")
    mkdirSync(join(installRoot, "app", "runtime"), { recursive: true })
    writeFileSync(join(installRoot, "app", "runtime", "nssm.exe"), "bin")
    expect(resolveNssm(installRoot)).toBe(join(installRoot, "app", "runtime", "nssm.exe"))
  })

  test("raíz paquete: runtime/nssm.exe (AppImage CLI)", () => {
    const root = join(tmp, "nssm-pkg-cli")
    mkdirSync(join(root, "runtime"), { recursive: true })
    writeFileSync(join(root, "runtime", "nssm.exe"), "bin")
    expect(resolveNssm(root)).toBe(join(root, "runtime", "nssm.exe"))
  })

  test("raíz paquete: resources/runtime/nssm.exe (NSIS/Tauri)", () => {
    const root = join(tmp, "nssm-pkg-tauri")
    mkdirSync(join(root, "resources", "runtime"), { recursive: true })
    writeFileSync(join(root, "resources", "runtime", "nssm.exe"), "bin")
    expect(resolveNssm(root)).toBe(join(root, "resources", "runtime", "nssm.exe"))
  })

  test("orden: raíz instalada ANTES que raíz de paquete", () => {
    const installRoot = join(tmp, "nssm-order", "install")
    const pkgRoot = join(tmp, "nssm-order", "pkg")
    mkdirSync(join(installRoot, "app", "runtime"), { recursive: true })
    writeFileSync(join(installRoot, "app", "runtime", "nssm.exe"), "bin")
    mkdirSync(join(pkgRoot, "resources", "runtime"), { recursive: true })
    writeFileSync(join(pkgRoot, "resources", "runtime", "nssm.exe"), "bin")
    expect(resolveNssm(installRoot, pkgRoot)).toBe(join(installRoot, "app", "runtime", "nssm.exe"))
  })

  test("raíces vacías/undefined y sin nssm → PATH ('nssm')", () => {
    expect(resolveNssm()).toBe("nssm")
    expect(resolveNssm(undefined)).toBe("nssm")
    expect(resolveNssm(join(tmp, "nssm-none"))).toBe("nssm")
    expect(resolveNssm(undefined, join(tmp, "nssm-none"))).toBe("nssm")
  })

  test("rutas inexistentes no rompen (existsSync tolerante)", () => {
    expect(resolveNssm(join(tmp, "no-existe-nunca"))).toBe("nssm")
    expect(existsSync(join(tmp, "no-existe-nunca"))).toBe(false)
  })
})
