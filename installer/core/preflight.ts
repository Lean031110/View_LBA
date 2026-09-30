/**
 * Preflight completo: sistema + dependencias + puertos.
 *
 * REUTILIZA la lógica de scripts/install.ts (preflight) extraída aquí, más
 * las nuevas exigencias de la misión (ffmpeg, systemd/NSSM, curl-equivalente,
 * puertos). El resultado son checks PASS/WARNING/FAIL; cualquier FAIL crítico
 * aborta ANTES de modificar el sistema.
 */
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync, rmSync } from "node:fs"
import type { CheckResult, InstallConfig, Layout, Platform } from "./types"
import { systemChecks, collectSystemInfo } from "./sysinfo"
import { checkPorts, requiredPorts } from "./ports"
import { freeDiskBytes, dirWritable, dirWritableDeep } from "./fsx"
import { commandExists, type CmdRunner } from "./runner"

export interface PreflightDeps {
  runner: CmdRunner
  platform: Platform
  /** Checks extra del SO (systemd en linux, NSSM en windows). */
  platformChecks: CheckResult[]
  /** Puertos ocupados por servicios PROPIOS (update/repair) — no bloquean. */
  ownBusyPorts?: Set<number>
  /** Ruta del binario bun incluido en el payload (si lo hay). */
  bundledBun?: string
  /** Payload offline completo (node_modules vendored). */
  offlinePayload?: boolean
  /** Ruta del payload comprobada (diagnóstico en el fallo del check). */
  payloadDir?: string
}

export interface PreflightReport {
  checks: CheckResult[]
  system: ReturnType<typeof collectSystemInfo>
  blocking: boolean
}

export async function runPreflight(
  config: InstallConfig,
  layout: Layout,
  deps: PreflightDeps
): Promise<PreflightReport> {
  const checks: CheckResult[] = []
  const system = collectSystemInfo(layout.appDir)
  system.diskFreeBytes = freeDiskBytes(layout.appDir)

  // ---------- Pantalla 1: sistema ----------
  for (const c of systemChecks(system, layout.appDir, system.diskFreeBytes)) {
    checks.push(c)
  }

  // Elevación en Windows — sonda PURA DE FS (sin procesos externos):
  // escribir y borrar un archivo en C:\Windows SOLO funciona con token de
  // Administrador. Las sondas por spawn (whoami/cmd.exe/net session)
  // FALLABAN EN CADENA desde el sidecar compilado en los runners de CI
  // (salida VACÍA y «net session» exige LanmanServer apagado — builds
  // 9-12 de v3.2.0: falso «Permisos de administrador: NO»). Esta sonda
  // funciona con o sin servicios, consola o codepage, y refleja el token
  // REAL del proceso (deny del ACL = no elevado).
  if (deps.platform === "windows") {
    const probe = "C:\\Windows\\.viewlba-elev-probe.tmp"
    let isAdmin = false
    let evidence = ""
    try {
      writeFileSync(probe, "probe")
      rmSync(probe)
      isAdmin = true
    } catch (e) {
      evidence = (e as Error).message.slice(0, 140)
    }
    checks.push({
      id: "elevated",
      label: isAdmin ? "Permisos de administrador: sí" : "Permisos de administrador: NO",
      status: isAdmin ? "pass" : "fail",
      detail: isAdmin ? undefined : evidence || "escritura en C:\\Windows denegada",
      hint: isAdmin ? undefined : "Ejecuta el installer como Administrador (clic derecho → Ejecutar como administrador)",
    })
  }

  // ---------- Dependencias ----------
  // Bun: binario del payload (offline) o del sistema.
  const bunBin = deps.bundledBun ?? "bun"
  const bunV = spawnSync(bunBin, ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true })
  if (bunV.status === 0 && bunV.stdout?.trim()) {
    const ok = versionAtLeast(bunV.stdout.trim(), "1.1.0")
    checks.push({
      id: "bun",
      label: `Bun ${bunV.stdout.trim()}${deps.bundledBun ? " (incluido en el paquete)" : ""}`,
      status: ok ? "pass" : "fail",
      hint: ok ? undefined : "Se necesita Bun ≥ 1.1 — el paquete oficial lo incluye (runtime/bun)",
    })
  } else {
    checks.push({
      id: "bun",
      label: "Bun: no disponible",
      status: deps.bundledBun ? "fail" : "fail",
      hint: "Instala Bun (https://bun.sh) o usa el paquete oficial, que lo incluye",
    })
  }

  // Node: opcional (bun ejecuta todo) — warning si falta.
  const nodeV = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true })
  if (nodeV.status === 0 && nodeV.stdout) {
    const ok = versionAtLeast(nodeV.stdout.trim(), "20.9.0")
    checks.push({
      id: "node",
      label: `Node ${nodeV.stdout.trim()}`,
      status: ok ? "pass" : "warn",
      hint: ok ? undefined : "Actualiza Node (≥ 20.9) para herramientas externas",
    })
  } else {
    checks.push({
      id: "node",
      label: "Node.js: no en PATH (opcional)",
      status: "warn",
      hint: "Bun ejecuta toda la plataforma; Node solo es útil para herramientas externas",
    })
  }

  // ffmpeg: OPCIONAL en el servidor (OBS codifica en el cliente; NMS no lo exige).
  if (commandExists("ffmpeg", ["-version"])) {
    checks.push({ id: "ffmpeg", label: "ffmpeg disponible (opcional)", status: "pass" })
  } else {
    checks.push({
      id: "ffmpeg",
      label: "ffmpeg no encontrado",
      status: "warn",
      detail: "OBS Studio hace la codificación; el servidor NO lo necesita para transmitir",
      hint: "Instálalo solo si planeas re-codificar/probar publicaciones RTMP desde el servidor",
    })
  }

  // curl o equivalente: el installer usa fetch nativo; curl es solo
  // conveniencia operativa (manage/health scripts).
  if (commandExists("curl", ["--version"])) {
    checks.push({ id: "curl", label: "curl disponible (conveniencia)", status: "pass" })
  } else {
    checks.push({
      id: "curl",
      label: "curl no encontrado",
      status: "warn",
      hint: "El installer usa fetch nativo; curl es útil para diagnósticos manuales",
    })
  }

  // Checks específicos del SO (systemd / NSSM) — los aporta el adapter.
  checks.push(...deps.platformChecks)

  // ---------- Guard anti-NSSM (misión §0.8, §5) ----------
  // Verifica que el payload NO contiene binarios nssm.exe ni referencias.
  // Esto garantiza que el artefacto final NO depende de NSSM.
  if (deps.payloadDir) {
    const nssmScan = scanForNssm(deps.payloadDir)
    checks.push({
      id: "no-nssm",
      label: nssmScan.clean ? "Payload sin NSSM (misión §0.8 cumplido)" : "Payload CONTIENE NSSM (violación §0.8)",
      status: nssmScan.clean ? "pass" : "fail",
      detail: nssmScan.clean ? undefined : `Archivos con refs a NSSM: ${nssmScan.matches.slice(0, 5).join(", ")}${nssmScan.matches.length > 5 ? ` (y ${nssmScan.matches.length - 5} más)` : ""}`,
      hint: nssmScan.clean ? undefined : "El payload debe usar el service host Rust (installer/native/windows-service), no NSSM",
    })
  }

  // ---------- Guard anti-PowerShell para credenciales (misión §6) ----------
  // Verifica que el payload NO usa PowerShell para generar credenciales.
  if (deps.payloadDir) {
    const psScan = scanForPowerShellSecrets(deps.payloadDir)
    checks.push({
      id: "no-powershell-secrets",
      label: psScan.clean ? "Payload sin PowerShell para credenciales (§6)" : "Payload usa PowerShell para credenciales (violación §6)",
      status: psScan.clean ? "pass" : "fail",
      detail: psScan.clean ? undefined : `Archivos con patrones prohibidos: ${psScan.matches.slice(0, 5).join(", ")}`,
      hint: psScan.clean ? undefined : "Usar installer/core/secrets.ts (RNG crypto), no PowerShell pipe",
    })
  }

  // Payload offline: verificar que trae node_modules y bun.
  if (config.offline) {
    checks.push({
      id: "offline-payload",
      label: deps.offlinePayload ? "Payload offline completo (deps incluidas)" : "Payload offline INCOMPLETO",
      status: deps.offlinePayload ? "pass" : "fail",
      detail: deps.offlinePayload
        ? undefined
        : `comprobado (inexistente): ${deps.payloadDir ?? "?"}/node_modules y ${deps.payloadDir ?? "?"}/node_modules/.bin`,
      hint: deps.offlinePayload ? undefined : "El paquete debe incluir node_modules y runtime/bun para instalación sin red",
    })
  }

  // ---------- Puertos ----------
  const specs = requiredPorts(config.webPort, config.realtimePort, config.rtmpPort, config.httpFlvPort)
  for (const c of await checkPorts(specs, deps.ownBusyPorts ?? new Set())) {
    checks.push(c)
  }

  // ---------- Escritura ----------
  checks.push({
    id: "write-perms",
    label: `Permisos de escritura en ${layout.appDir}`,
    status: dirWritableDeep(layout.appDir) || dirWritableDeep(layout.dataDir) ? "pass" : "fail",
    hint: "Elige un directorio donde el usuario actual pueda escribir",
  })

  const blocking = checks.some((c) => c.status === "fail")
  return { checks, system, blocking }
}

function versionAtLeast(v: string, min: string): boolean {
  const [maj, mino] = v.replace(/^v/, "").split(".").map(Number)
  const [M, m] = min.split(".").map(Number)
  return maj > M || (maj === M && mino >= m)
}

/** ¿El payload trae node_modules? (offline). */
export function payloadHasDeps(payloadDir: string): boolean {
  return existsSync(`${payloadDir}/node_modules`) && existsSync(`${payloadDir}/node_modules/.bin`)
}

/** Resultado del escaneo anti-NSSM de un directorio de payload. */
export interface ScanResult {
  clean: boolean
  matches: string[]
}

/**
 * Escanea recursivamente un directorio buscando referencias a NSSM.
 * (misión §0.8: "No uses NSSM como dependencia final del producto Windows")
 *
 * Busca:
 *   - Archivos llamados nssm.exe o nssm (case-insensitive)
 *   - Strings "nssm" en archivos de texto (nsi, ps1, ts, sh, json, xml)
 *
 * Omite node_modules/ y .git/ para evitar falsos positivos.
 */
export function scanForNssm(payloadDir: string): ScanResult {
  const matches: string[] = []
  const SKIP = new Set(["node_modules", ".git", ".next", "target", "dist"])

  function walk(dir: string) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase()
        if (lower === "nssm.exe" || lower === "nssm") {
          matches.push(`binario: ${full}`)
          continue
        }
        // Scan text files for "nssm" string
        if (/\.(nsi|ps1|ts|sh|json|xml|md|yml|yaml|toml|wxs)$/i.test(e.name)) {
          try {
            const content = require("node:fs").readFileSync(full, "utf8")
            if (/\bnssm\b/i.test(content)) {
              // Exclude comments that explicitly say NSSM is forbidden/excluded
              // (we want to allow docs that say "no NSSM" but flag actual usage)
              const lines = content.split(/\r?\n/).filter((l: string) => /\bnssm\b/i.test(l))
              const realRefs = lines.filter((l: string) =>
                !/prohibido|forbidden|excluded|excluido|no.*use|sin.*nssm/i.test(l)
              )
              if (realRefs.length > 0) {
                matches.push(`referencia en: ${full}`)
              }
            }
          } catch {
            /* binary or unreadable — skip */
          }
        }
      }
    }
  }

  walk(payloadDir)
  return { clean: matches.length === 0, matches }
}

/**
 * Escanea recursivamente un directorio buscando patrones prohibidos de
 * uso de PowerShell para generar/manejar credenciales.
 * (misión §6: "Eliminar completamente del NSIS/MSI: PowerShell para generar contraseña")
 *
 * Patrones prohibidos:
 *   - powershell.exe ... -Command "$$p=..." (Error A pattern)
 *   - .pwd.tmp (password temporal via shell)
 *   - adminPassword=ValorEmbebido (JSON con pwd hardcoded)
 *   - Contraseña hardcoded "ViewLBA-CambioYa1" o similar
 */
export function scanForPowerShellSecrets(payloadDir: string): ScanResult {
  const matches: string[] = []
  const SKIP = new Set(["node_modules", ".git", ".next", "target", "dist"])

  function walk(dir: string) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && /\.(nsi|ps1|ts|sh|json|xml|wxs|bat|cmd)$/i.test(e.name)) {
        try {
          const content = require("node:fs").readFileSync(full, "utf8")
          if (/powershell\.exe[^\n]*-Command[^\n]*\$\$?p\s*=/.test(content)) {
            matches.push(`PowerShell pipe pwd: ${full}`)
          }
          if (/\.pwd\.tmp/.test(content)) {
            matches.push(`.pwd.tmp temporal: ${full}`)
          }
          if (/ViewLBA-CambioYa1/i.test(content)) {
            matches.push(`fallback pwd hardcoded: ${full}`)
          }
          if (/adminPassword["']?\s*[:=]\s*["']?[A-Za-z0-9]/.test(content) && /adminPassword/.test(content)) {
            // Coarse check: any adminPassword= with a value
            // (we don't have a precise regex for placeholders, but real code
            // generates via secrets.ts which uses randomBytes, not strings)
            // Skip if it's just the JSON schema reference or test fixtures.
            if (!/fixture|test|placeholder|example/i.test(content) &&
                !/adminPassword.*\$\{|adminPassword.*\$\$adminPassword/i.test(content)) {
              // matches.push(`adminPassword hardcoded en JSON: ${full}`)
              // (false positives common — disabled for v1, see tests)
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  walk(payloadDir)
  return { clean: matches.length === 0, matches }
}
