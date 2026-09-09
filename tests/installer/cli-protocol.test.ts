/**
 * Tests del PROTOCOLO CLI↔GUI (NDJSON por stdout) — spawn REAL del CLI.
 *
 * El CLI se lanza con --json; la "GUI" (este test) escribe la config por
 * stdin y consume eventos NDJSON. En este sandbox preflight falla por
 * systemd/elevación (real, sin mockear) → se valida precisamente el camino
 * de fallo honrado: eventos válidos, diagnóstico estructurado y exit != 0.
 *
 * La ruta de ÉXITO completa (con systemd) se valida en CI/hosts reales.
 */
import { describe, test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"

const CLI = join(import.meta.dir, "..", "..", "installer", "cli", "main.ts")

interface LineCollector {
  events: Array<Record<string, unknown>>
  stderr: string
  code: number | null
}

function runCli(args: string[], stdinData?: string, timeoutMs = 60_000): Promise<LineCollector> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    })
    const out: LineCollector = { events: [], stderr: "", code: null }
    let buf = ""
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error("timeout del CLI"))
    }, timeoutMs)
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8")
      let idx: number
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          out.events.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          out.stderr += `[stdout-no-json] ${line}\n`
        }
      }
    })
    proc.stderr.on("data", (d: Buffer) => {
      out.stderr += d.toString("utf8")
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      out.code = code
      resolve(out)
    })
    proc.on("error", reject)
    if (stdinData !== undefined) {
      proc.stdin.write(stdinData)
      proc.stdin.end()
    } else {
      proc.stdin.end()
    }
  })
}

describe("CLI --json (protocolo NDJSON de la GUI)", () => {
  test("evento inicial + fallo honrado de preflight (sandbox sin systemd/root) + exit != 0", async () => {
    const config = JSON.stringify({
      type: "config",
      config: {
        mode: "new",
        restaurantName: "Test Restaurante",
        timezone: "America/Havana",
        webPort: 34521,
        realtimePort: 34523,
        rtmpPort: 34525,
        httpFlvPort: 34527,
        lanMode: true,
        lanSubnet: "192.168.1.0/24",
        withDemoData: false,
        offline: false,
        runBuild: true,
      },
    })
    const out = await runCli(["--json"], config + "\n")
    const types = out.events.map((e) => e.type)

    // Protocolo: primera línea es info de espera
    expect(types[0]).toBe("info")
    // Se emite el arranque de fase y checks
    expect(types).toContain("phase-start")
    expect(types).toContain("check")
    // En este sandbox el preflight FALLA de verdad (sin systemd / sin root):
    // el protocolo exige terminar con "failed" + diagnóstico estructurado.
    const failed = out.events.find((e) => e.type === "failed")
    expect(failed).toBeDefined()
    const diag = (failed as { diagnostic: Record<string, string> }).diagnostic
    expect(diag.phase).toBe("preflight")
    expect(typeof diag.error).toBe("string")
    expect(typeof diag.suggestion).toBe("string")
    expect(diag.suggestion.length).toBeGreaterThan(10)
    // Sin "done" engañoso
    expect(types).not.toContain("done")
    expect(out.code).not.toBe(0)
    // Todos los eventos son JSON válido (nada de logs humanos en stdout)
    expect(out.stderr).not.toContain("[stdout-no-json]")
    // La fase fallida también quedó registrada como phase-end fail
    const phaseEnds = out.events.filter((e) => e.type === "phase-end") as Array<{ phase: string; status: string }>
    expect(phaseEnds.some((p) => p.status === "fail")).toBe(true)
  }, 90_000)

  test("sin config de la GUI → failed con sugerencia (timeout corto no aplica: stdin cerrado)", async () => {
    // stdin cerrado sin config → readGuiMessage recibe EOF... el collector
    // resuelve null al cerrar el stream → mensaje "failed" claro.
    const out = await runCli(["--json"], "")
    const failed = out.events.find((e) => e.type === "failed")
    expect(failed).toBeDefined()
    expect(out.code).not.toBe(0)
  }, 90_000)
})

describe("CLI comandos de gestión", () => {
  test("subcomando desconocido → help + exit 1", async () => {
    const out = await runCli(["comando-inexistente"])
    expect(out.code).toBe(1)
    expect(out.stderr + JSON.stringify(out.events)).toContain("ViewLBA Server Installer")
  }, 30_000)

  test("preflight: checks reales en consola (systemd/elevación honestos)", async () => {
    const out = await runCli(["preflight"], undefined, 60_000)
    // En sandbox falla (sin root) — lo importante: sale con diagnóstico,
    // sin colgarse (protocolo de finalización correcto).
    expect(out.code === 0 || out.code === 1).toBe(true)
    expect(out.stderr).not.toBe("") // hay salida humana
  }, 90_000)

  test("services status sin instalación → mensaje claro + exit 1", async () => {
    const out = await runCli(["services", "status"], undefined, 60_000)
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("No hay instalación")
  }, 90_000)
})
