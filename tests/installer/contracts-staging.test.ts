/**
 * Contrato I: Staging completo del producto Windows
 * ================================================
 *
 * MISIÓN §12:
 *   El staging debe contener EXACTAMENTE lo que recibe el cliente.
 *   No un "ejemplo" ni un "esqueleto" — el producto REAL.
 *
 * Estructura requerida (stage dir):
 *   dist/release/windows/ViewLBA-Server/
 *     ├── bin/
 *     │   ├── viewlba-service.exe        (Rust service host)
 *     │   ├── viewlba-tray.exe           (Rust tray)
 *     │   └── viewlba-installer.exe      (TS sidecar, bun-compile)
 *     ├── runtime/
 *     │   └── bun.exe                    (Bun runtime incluido)
 *     ├── app/                           (Next.js standalone)
 *     │   ├── server.js
 *     │   ├── .next/
 *     │   ├── node_modules/
 *     │   ├── prisma/
 *     │   └── scripts/start.ts
 *     ├── mini-services/
 *     │   ├── realtime-service/
 *     │   │   ├── index.ts
 *     │   │   └── node_modules/
 *     │   └── stream-service/
 *     │       ├── index.ts
 *     │       └── node_modules/
 *     ├── themes/                        (.vtheme files)
 *     ├── public/                        (assets estáticos)
 *     ├── assets/                        (icons, etc.)
 *     └── manifest.json
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - Exista un script que construya el staging completo
 *   - El script se llame desde CI
 *   - El staging contenga todos los archivos requeridos
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, REPO_ROOT, walkAndCollect } from "./_helpers"
import { existsSync } from "node:fs"
import { join } from "node:path"

describe("CONTRATO I: Staging completo del producto Windows", () => {
  test("EXISTS: scripts/stage-windows.ts (o equivalente)", () => {
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
    ]
    let found = false
    for (const p of candidates) {
      try {
        readRepoFile(p)
        found = true
        break
      } catch {
        // not found
      }
    }
    expect(found).toBe(true)
  })

  test("stage script COPIA viewlba-service.exe al staging", () => {
    // El script de staging debe referenciar viewlba-service.exe
    // (sea cual sea el nombre del script)
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/viewlba-service\.exe/i)
  })

  test("stage script COPIA viewlba-tray.exe al staging", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/viewlba-tray\.exe/i)
  })

  test("stage script INCLUYE Bun runtime (bun.exe)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/bun\.exe|bun.*runtime/i)
  })

  test("stage script INCLUYE Next.js standalone (.next/standalone)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
      "scripts/build.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/standalone|\.next/i)
  })

  test("stage script INCLUYE mini-services (realtime + stream)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/realtime-service/i)
    expect(content).toMatch(/stream-service/i)
  })

  test("stage script INCLUYE prisma (schema + migrations + client)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
      "scripts/build.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/prisma/i)
  })

  test("stage script INCLUYE themes (.vtheme files)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/themes|\.vtheme/i)
  })

  test("stage script INCLUYE public (assets estáticos)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
      "installer/package/bundle-server.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/public/i)
  })

  test("stage script GENERA manifest.json en staging", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    expect(content).toMatch(/manifest\.json/i)
  })

  test("stage script NO incluye rutas del entorno de build (runner, $bunfs, etc.)", () => {
    let content = ""
    const candidates = [
      "scripts/stage-windows.ts",
      "scripts/build-windows-staging.ts",
      "installer/package/stage-windows.ts",
    ]
    for (const p of candidates) {
      try {
        content += readRepoFile(p) + "\n"
      } catch {
        // skip
      }
    }
    // No debe haber rutas del runner o del workspace
    expect(content).not.toMatch(/\/home\/runner\/work|C:\\Users\\runneradmin|B:\/~BUN|\$bunfs/i)
  })
})
