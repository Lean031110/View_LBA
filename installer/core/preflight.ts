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
