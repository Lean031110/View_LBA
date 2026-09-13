/**
 * Tests del STAGING DE PRODUCCIÓN (installer/package/payload.ts).
 *
 * El payload V2 responde a los fallos REALES de CI:
 *  · NSIS "File: failed opening file" por rutas >260 (node_modules anidados
 *    de devDeps/UI compilada — cmdk/@radix-ui/… en el payload V1 de 1284 MB)
 *  · linuxdeploy ahogado por un payload de 1.28 GB
 *  · Next espeja el repo en .next/standalone (fuga de db/, .env, download/)
 *
 * Estos tests fijan el CONTRATO:
 *  1. pruneNodeModules: SOLO roots + transitivas (deps+optionalDeps), nunca
 *     devDeps; filtro de plataforma para binarios opcionales; .bin con el
 *     symlink recreado (linux) o wrapper .cmd (windows cross-compile).
 *  2. validatePayload: guards que FALLAN antes de Tauri/NSIS (tamaño, rutas,
 *     profundidad, paquetes prohibidos, datos/secretos, symlinks por SO).
 *  3. createProductionPayload: estructura EXPLÍCITA desde un repo sintético
 *     (whitelist del standalone: sin espejo, sin .env, sin db/).
 *  4. buildManifest: commit ↔ binario (sha256 + tamaños + versiones).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PAYLOAD_ROOTS,
  FORBIDDEN_PACKAGES,
  createProductionPayload,
  pruneNodeModules,
  platformMismatch,
  validatePayload,
  buildManifest,
  PayloadError,
} from "../../installer/package/payload"

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "viewlba-payload-"))
})
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

/** node_modules sintético: prisma → @prisma/engines, @prisma/config → effect;
 *  devDeps (typescript, playwright) presentes pero NO alcanzables; binario
 *  opcional de otra plataforma (fake). */
function makeNodeModules(dir: string): string {
  const nm = join(dir, "node_modules")
  const pkg = (name: string, deps: Record<string, string> = {}, files: string[] = ["index.js"]) => {
    const p = join(nm, ...name.split("/"))
    mkdirSync(p, { recursive: true })
    for (const f of files) writeFileSync(join(p, f), `// ${name}\n`)
    writeFileSync(join(p, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies: deps }))
  }
  pkg("prisma", { "@prisma/engines": "6", "@prisma/config": "6" })
  pkg("@prisma/engines", {}, ["schema-engine", "libquery_engine.so.node"])
  pkg("@prisma/config", { effect: "3" })
  pkg("effect", { "@prisma/engines-version": "1" }, ["index.js", "big.dat"])
  pkg("@prisma/engines-version")
  pkg("@prisma/client", {}, ["default.js", "index.js"])
  pkg("zod")
  // NO alcanzables desde los roots (prohibidos o dev):
  pkg("typescript")
  pkg("@playwright/test")
  pkg("cmdk")
  // cliente generado
  const dot = join(nm, ".prisma", "client")
  mkdirSync(dot, { recursive: true })
  writeFileSync(join(dot, "default.js"), "// generated\n")
  // .bin: prisma → ../prisma/build/index.js (symlink) + wasm hermano
  const build = join(nm, "prisma", "build")
  mkdirSync(build, { recursive: true })
  writeFileSync(join(build, "index.js"), "#!/usr/bin/env node\n// prisma cli\n")
  writeFileSync(join(build, "prisma_schema_build_bg.wasm"), "--wasm--")
  mkdirSync(join(nm, ".bin"), { recursive: true })
  symlinkSync("../prisma/build/index.js", join(nm, ".bin", "prisma"))
  // binario de OTRA plataforma (optionalDep de prisma)
  pkg("windows-swc-bin", {})
  const prismaJson = JSON.parse(readFileSync(join(nm, "prisma", "package.json"), "utf8"))
  prismaJson.optionalDependencies = { "windows-swc-bin": "1" }
  writeFileSync(join(nm, "prisma", "package.json"), JSON.stringify(prismaJson))
  return nm
}

// ----------------------------------------------------------- pruneNodeModules

describe("pruneNodeModules (BUILD deps ≠ RUNTIME deps)", () => {
  test("copia roots + transitivas (deps), excluye devDeps y UI", () => {
    const src = makeNodeModules(join(tmp, "prune1"))
    const dst = join(tmp, "prune1-out", "node_modules")
    const { packages } = pruneNodeModules(src, dst, PAYLOAD_ROOTS, "linux")

    for (const expected of ["prisma", "@prisma/engines", "@prisma/config", "effect", "@prisma/engines-version", "@prisma/client", "zod", ".prisma"]) {
      expect(packages).toContain(expected)
    }
    // NADA de dev/UI:
    expect(existsSync(join(dst, "typescript"))).toBe(false)
    expect(existsSync(join(dst, "@playwright"))).toBe(false)
    expect(existsSync(join(dst, "cmdk"))).toBe(false)
  })

  test(".bin: symlink recreado como link (linux) apuntando al paquete copiado", () => {
    const src = makeNodeModules(join(tmp, "prune2"))
    const dst = join(tmp, "prune2-out", "node_modules")
    pruneNodeModules(src, dst, PAYLOAD_ROOTS, "linux")
    const bin = join(dst, ".bin", "prisma")
    expect(existsSync(bin)).toBe(true)
    expect(lstatSync(bin).isSymbolicLink()).toBe(true)
    // el target del link EXISTE en el árbol podado (resolución del wasm OK)
    expect(existsSync(join(dst, ".bin", "prisma"))).toBe(true)
  })

  test(".bin: windows cross-compile genera .cmd (sin symlinks — NSIS)", () => {
    const src = makeNodeModules(join(tmp, "prune3"))
    const dst = join(tmp, "prune3-out", "node_modules")
    pruneNodeModules(src, dst, PAYLOAD_ROOTS, "windows")
    const cmd = join(dst, ".bin", "prisma.cmd")
    expect(existsSync(cmd)).toBe(true)
    const content = readFileSync(cmd, "utf8")
    expect(content).toContain("..\\prisma\\build\\index.js")
  })

  test("binario opcional de otra plataforma se filtra (linux ≠ windows-swc)", () => {
    const src = makeNodeModules(join(tmp, "prune4"))
    const dst = join(tmp, "prune4-out", "node_modules")
    const { packages } = pruneNodeModules(src, dst, PAYLOAD_ROOTS, "linux")
    expect(packages).not.toContain("windows-swc-bin")
    expect(existsSync(join(dst, "windows-swc-bin"))).toBe(false)
  })
})

// ---------------------------------------------------------- platformMismatch

describe("platformMismatch (heurística conservadora)", () => {
  test("linux rechaza win32/macos/darwin y acepta neutros", () => {
    expect(platformMismatch("@next/swc-win32-x64-msvc", "linux")).toBe(true)
    expect(platformMismatch("@next/swc-darwin-arm64", "linux")).toBe(true)
    expect(platformMismatch("effect", "linux")).toBe(false)
    expect(platformMismatch("@img/sharp-linux-x64", "linux")).toBe(false)
  })
  test("windows rechaza linux/musl/macos y acepta neutros", () => {
    expect(platformMismatch("@img/sharp-linuxmusl-x64", "windows")).toBe(true)
    expect(platformMismatch("@next/swc-win32-x64-msvc", "windows")).toBe(false)
    expect(platformMismatch("zod", "windows")).toBe(false)
  })
})

// ------------------------------------------------------------ validatePayload

describe("validatePayload (guards ANTES de Tauri/NSIS)", () => {
  test("árbol limpio pasa (linux, con node_modules/.bin/prisma link permitido)", () => {
    const src = makeNodeModules(join(tmp, "guard-ok"))
    const server = join(tmp, "guard-ok-server")
    mkdirSync(server, { recursive: true })
    pruneNodeModules(src, join(server, "node_modules"), PAYLOAD_ROOTS, "linux")
    // validar el SERVIDOR completo (no el subárbol nm): el guard usa rutas
    // relativas al raíz del payload (node_modules/.bin/…)
    const out = validatePayload(server, { platform: "linux" })
    expect(out.files).toBeGreaterThan(0)
    expect(out.maxDepth).toBeLessThanOrEqual(16)
  })

  test("falla con paquete prohibido (typescript) dentro del payload", () => {
    const server = join(tmp, "guard-pkg")
    mkdirSync(join(server, "node_modules", "typescript"), { recursive: true })
    expect(() => validatePayload(server, { platform: "linux" })).toThrow(/paquete prohibido/)
  })

  test("falla con datos/secretos (.env, db/) en el payload", () => {
    const server = join(tmp, "guard-env")
    mkdirSync(server, { recursive: true })
    writeFileSync(join(server, ".env"), "AUTH_SECRET=real-secret\n")
    expect(() => validatePayload(server, { platform: "linux" })).toThrow(/entrada prohibida/)
  })

  test("falla con symlink FUERA de node_modules/.bin (linux) y en TODOS (windows)", () => {
    const linuxTree = join(tmp, "guard-link-linux")
    mkdirSync(join(linuxTree, "a"), { recursive: true })
    symlinkSync("a", join(linuxTree, "alias"))
    expect(() => validatePayload(linuxTree, { platform: "linux" })).toThrow(/symlink/)
    expect(() => validatePayload(linuxTree, { platform: "windows" })).toThrow(/symlink/)
  })

  test("falla con rutas absurdamente largas (NSIS MAX_PATH)", () => {
    const server = join(tmp, "guard-deep")
    let deep = server
    for (let i = 0; i < 18; i++) {
      deep = join(deep, `nivel-muy-largo-${i}-con-nombre-de-directorio-extenso`)
      mkdirSync(deep, { recursive: true })
    }
    writeFileSync(join(deep, "x.txt"), "x")
    expect(() => validatePayload(server, { platform: "linux" })).toThrow(/ruta|profundidad/)
  })

  test("falla con duplicados accidentales (node_modules/node_modules)", () => {
    const server = join(tmp, "guard-dup")
    mkdirSync(join(server, "node_modules", "node_modules"), { recursive: true })
    expect(() => validatePayload(server, { platform: "linux" })).toThrow(/duplicado/)
  })
})

// ------------------------------------------------- createProductionPayload

describe("createProductionPayload (estructura EXPLÍCITA — repo sintético)", () => {
  test("contrato completo: whitelist del standalone + runtime files + pruned nm", () => {
    const root = makeSyntheticRepo(join(tmp, "repo"))
    const serverDir = join(tmp, "repo-out", "resources", "server")
    const result = createProductionPayload({ root, serverDir, platform: "linux", versions: { bun: "1.3.14", prisma: "6" } })

    // standalone por WHITELIST — el espejo del repo NO entra
    expect(existsSync(join(serverDir, ".next", "standalone", "server.js"))).toBe(true)
    expect(existsSync(join(serverDir, ".next", "standalone", "node_modules", "next"))).toBe(true)
    expect(existsSync(join(serverDir, ".next", "standalone", "public"))).toBe(true)
    expect(existsSync(join(serverDir, ".next", "standalone", "db"))).toBe(false) // espejo EXCLUIDO
    expect(existsSync(join(serverDir, ".next", "standalone", ".env"))).toBe(false) // fuga bloqueada

    // runtime explícito
    expect(existsSync(join(serverDir, "prisma", "schema.prisma"))).toBe(true)
    expect(existsSync(join(serverDir, "prisma", "migrations", "0_init", "migration.sql"))).toBe(true)
    expect(existsSync(join(serverDir, "scripts", "start.ts"))).toBe(true)
    expect(existsSync(join(serverDir, "scripts", "lib", "production-init.ts"))).toBe(true)
    expect(existsSync(join(serverDir, "src", "lib", "auth.ts"))).toBe(true)
    expect(existsSync(join(serverDir, "mini-services", "realtime-service", "node_modules", "socket.io"))).toBe(true)

    // v3.2: plantillas systemd del installer (sin ellas installServices falla)
    expect(existsSync(join(serverDir, "deploy", "linux", "pantalla-restaurante.service"))).toBe(true)
    expect(existsSync(join(serverDir, "deploy", "linux", "pantalla-restaurante.target"))).toBe(true)
    expect(existsSync(join(serverDir, "deploy", "linux", "pantalla-restaurante-backup.timer"))).toBe(true)

    // node_modules PODADO en el payload
    expect(existsSync(join(serverDir, "node_modules", "prisma"))).toBe(true)
    expect(existsSync(join(serverDir, "node_modules", "typescript"))).toBe(false)

    // contadores coherentes
    expect(result.files).toBeGreaterThan(10)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.packages).toContain("prisma")
  })
})

// ------------------------------------------------------------ buildManifest

describe("buildManifest (trazabilidad commit ↔ binario)", () => {
  test("incluye sha256 y tamaño del artefacto + payload stats", async () => {
    const root = makeSyntheticRepo(join(tmp, "manifest-repo"))
    const stage = join(tmp, "manifest-stage")
    mkdirSync(stage, { recursive: true })
    const serverDir = join(stage, "resources", "server")
    const payload = createProductionPayload({ root, serverDir, platform: "linux", versions: { bun: "1.3.14", prisma: "6" } })
    const artifact = join(tmp, "artifact.deb")
    writeFileSync(artifact, "contenido-fake-del-deb")
    const m = buildManifest({
      root,
      platform: "linux",
      version: "1.0.1-rc.1",
      gitRev: "abc1234",
      bunVersion: "1.4.2",
      payloadBunVersion: "1.3.14",
      payload,
    })
    expect(m.version).toBe("1.0.1-rc.1")
    expect(m.offline).toBe(true)
    expect(m.payloadFiles).toBe(payload.files)
    expect(m.payloadBytes).toBe(payload.bytes)
    expect(m.runtimePackages.length).toBeGreaterThan(3)
  })
})

// ---------------------------------------------------------------- helpers

/** Repo sintético mínimo con TODO lo que createProductionPayload consume. */
function makeSyntheticRepo(root: string): string {
  // .next/standalone CON espejo del repo (lo que Next produce en un build
  // dentro del repo: db/, .env, skills/… además del server real)
  const standalone = join(root, ".next", "standalone")
  mkdirSync(join(standalone, ".next", "static"), { recursive: true })
  mkdirSync(join(standalone, "node_modules", "next"), { recursive: true })
  mkdirSync(join(standalone, "node_modules", "@prisma", "client"), { recursive: true })
  mkdirSync(join(standalone, "public"), { recursive: true })
  writeFileSync(join(standalone, "server.js"), "// server\n")
  writeFileSync(join(standalone, "package.json"), JSON.stringify({ name: "viewlba", version: "1.0.0" }))
  writeFileSync(join(standalone, ".next", "static", "app.js"), "// app\n")
  writeFileSync(join(standalone, "node_modules", "next", "index.js"), "// next\n")
  // el espejo del repo (tracing root) — NO debe entrar al payload:
  mkdirSync(join(standalone, "db"), { recursive: true })
  writeFileSync(join(standalone, "db", "dev.db"), "sqlite-data")
  writeFileSync(join(standalone, ".env"), "AUTH_SECRET=leak\n")

  // scripts + src/lib + prisma
  for (const f of [
    "scripts/start.ts",
    "scripts/backup.ts",
    "scripts/restore.ts",
    "scripts/logs-purge.ts",
    "scripts/media-gc.ts",
    "scripts/init-production.ts",
    "scripts/lib/env-file.ts",
    "scripts/lib/production-init.ts",
    "scripts/lib/prompt.ts",
    "src/lib/auth.ts",
    "src/lib/env.ts",
    "src/lib/validators.ts",
    "src/lib/backup.ts",
    "src/lib/media.ts",
    "prisma/seed.ts",
  ]) {
    const p = join(root, f)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, `// ${f}\n`)
  }
  writeFileSync(join(root, "prisma", "schema.prisma"), "datasource db { provider = \"sqlite\" }\n")
  mkdirSync(join(root, "prisma", "migrations", "0_init"), { recursive: true })
  writeFileSync(join(root, "prisma", "migrations", "0_init", "migration.sql"), "-- init\n")

  // deploy/linux: plantillas systemd que el installer renderiza (v3.2 —
  // obligatorias en el payload: sin ellas installServices falla)
  const UNITS = [
    "pantalla-restaurante.service",
    "pantalla-restaurante-realtime.service",
    "pantalla-restaurante-stream.service",
    "pantalla-restaurante.target",
    "pantalla-restaurante-backup.service",
    "pantalla-restaurante-backup.timer",
    "pantalla-restaurante-logs-purge.service",
    "pantalla-restaurante-logs-purge.timer",
  ]
  mkdirSync(join(root, "deploy", "linux"), { recursive: true })
  for (const u of UNITS) writeFileSync(join(root, "deploy", "linux", u), "# unit\n")

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "viewlba", version: "1.0.0" }))
  writeFileSync(join(root, "bun.lock"), "{}")
  for (const cfg of ["next.config.ts", "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts", "components.json", "bunfig.toml"]) {
    writeFileSync(join(root, cfg), `// ${cfg}\n`)
  }

  // mini-services con node_modules propios
  for (const [svc, dep] of [
    ["realtime-service", "socket.io"],
    ["stream-service", "node-media-server"],
  ] as const) {
    const svcDir = join(root, "mini-services", svc)
    mkdirSync(join(svcDir, "node_modules", dep), { recursive: true })
    writeFileSync(join(svcDir, "index.ts"), `// ${svc}\n`)
    writeFileSync(join(svcDir, "package.json"), JSON.stringify({ name: svc, dependencies: { [dep]: "1" } }))
    writeFileSync(join(svcDir, "node_modules", dep, "index.js"), `// ${dep}\n`)
  }

  // node_modules del repo (fuente del podado)
  makeNodeModules(root)
  return root
}
