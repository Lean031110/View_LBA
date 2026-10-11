/**
 * Tests del logging estructurado en installer/core/diagnostics.ts (misión §2).
 *
 * Verifica:
 *   - redactSecrets elimina patrones de secreto conocidos
 *   - buildDiagnostic incluye TODOS los campos requeridos por misión §2:
 *     fase, command, argv, cwd, exitCode, stdout, stderr, timeout,
 *     affectedService, binaryPath, runtimeVersion
 *   - renderDiagnostic produce output con todos los campos
 *   - nunca se imprimen passwords/tokens/secretos en stdout/stderr capturados
 */
import { describe, test, expect } from "bun:test"
import {
  redactSecrets,
  buildDiagnostic,
  renderDiagnostic,
  diagnosticFromRunResult,
} from "../../installer/core/diagnostics"

describe("redactSecrets: jamás loguea secretos (misión §2)", () => {
  test("redacta AUTH_SECRET=valorhex", () => {
    const out = redactSecrets("AUTH_SECRET=abcdef0123456789abcdef0123456789")
    expect(out).not.toMatch(/[a-f0-9]{32}/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta REALTIME_TOKEN=valorhex", () => {
    const out = redactSecrets("REALTIME_TOKEN=abcdef0123456789")
    expect(out).not.toMatch(/abcdef0123456789/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta credenciales en URL postgres://user:pass@", () => {
    const out = redactSecrets("postgres://admin:SuperSecret123@db:5432/db")
    expect(out).not.toMatch(/SuperSecret123/)
    expect(out).toMatch(/USER/)
    expect(out).toMatch(/PASS/)
  })

  test("redacta password=valor en querystring", () => {
    const out = redactSecrets("user=admin&password=MyP4ssw0rd!")
    expect(out).not.toMatch(/MyP4ssw0rd!/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta adminPassword=valor en JSON", () => {
    const out = redactSecrets('{"adminEmail":"a@b.c","adminPassword":"ViewLBA-ABCD1234-7x"}')
    expect(out).not.toMatch(/ViewLBA-ABCD1234-7x/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX1")
    expect(out).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX1/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta ViewLBA-XXXX-YYYY pattern (admin password generada)", () => {
    const out = redactSecrets("User created: admin@viewlba.local Pass: ViewLBA-ABCD1234-7x")
    expect(out).not.toMatch(/ViewLBA-ABCD1234-7x/)
    expect(out).toMatch(/REDACTED/)
  })

  test("redacta github_pat_ tokens (belt-and-suspenders)", () => {
    // Usamos un placeholder FAKE (no un token real) — secret scanning
    // de GitHub bloquearía cualquier token real en un commit.
    const fake = "github_pat_" + "A".repeat(60)
    const out = redactSecrets(`Using token ${fake}`)
    expect(out).not.toMatch(/A{60}/)
    expect(out).toMatch(/github_pat_\[REDACTED\]/)
  })

  test("string sin secretos se devuelve sin cambios", () => {
    const out = redactSecrets("Installation complete: ViewLBA Server 3.2.3")
    expect(out).toBe("Installation complete: ViewLBA Server 3.2.3")
  })

  test("string vacío no rompe", () => {
    expect(redactSecrets("")).toBe("")
    expect(redactSecrets(undefined as unknown as string)).toBe("")
  })
})

describe("buildDiagnostic: campos estructurados misión §2", () => {
  test("incluye TODOS los campos requeridos", () => {
    const d = buildDiagnostic({
      phase: "services",
      area: "STREAM SERVICE",
      error: "Port 1935 unavailable",
      command: "nssm.exe",
      argv: ["start", "ViewLBAStream"],
      cwd: "C:\\ProgramData\\ViewLBA",
      exitCode: 1,
      stdout: "Service ViewLBAStream already running",
      stderr: "Cannot bind to 1935",
      timedOut: false,
      timeoutMs: 30000,
      affectedService: "ViewLBAStream",
      binaryPath: "C:\\Program Files\\ViewLBA Server\\runtime\\nssm.exe",
      runtimeVersion: "bun 1.3.14",
      logPath: "C:\\ProgramData\\ViewLBA\\logs\\stream.log",
      affectedFile: "C:\\ProgramData\\ViewLBA\\data\\db\\custom.db",
    })

    expect(d.phase).toBe("services")
    expect(d.area).toBe("STREAM SERVICE")
    expect(d.command).toBe("nssm.exe")
    expect(d.argv).toEqual(["start", "ViewLBAStream"])
    expect(d.cwd).toBe("C:\\ProgramData\\ViewLBA")
    expect(d.exitCode).toBe(1)
    expect(d.stdout).toContain("Service ViewLBAStream already running")
    expect(d.stderr).toContain("Cannot bind to 1935")
    expect(d.timedOut).toBe(false)
    expect(d.timeoutMs).toBe(30000)
    expect(d.affectedService).toBe("ViewLBAStream")
    expect(d.binaryPath).toBe("C:\\Program Files\\ViewLBA Server\\runtime\\nssm.exe")
    expect(d.runtimeVersion).toBe("bun 1.3.14")
    expect(d.logPath).toBe("C:\\ProgramData\\ViewLBA\\logs\\stream.log")
    expect(d.affectedFile).toBe("C:\\ProgramData\\ViewLBA\\data\\db\\custom.db")
    expect(d.suggestion.length).toBeGreaterThan(10)
  })

  test("regla de sugerencia: Error A (PowerShell ParserError)", () => {
    const d = buildDiagnostic({
      phase: "services",
      error: "PowerShell ParserError: Debe proporcionar una expresión de valor después del operador '='",
    })
    expect(d.suggestion).toMatch(/secrets\.ts/i)
    expect(d.suggestion).toMatch(/PowerShell/i)
  })

  test("regla de sugerencia: Error B (FIND formato incorrecto)", () => {
    const d = buildDiagnostic({
      phase: "services",
      error: "FIND: formato de parámetros incorrecto",
    })
    expect(d.suggestion).toMatch(/find/i)
    expect(d.suggestion).toMatch(/Win32 API|Get-Service|sidecar/i)
  })

  test("regla de sugerencia: Error C (NSSM 2.24 usage screen)", () => {
    const d = buildDiagnostic({
      phase: "services",
      error: "NSSM 2.24 mostrando su pantalla de uso",
    })
    expect(d.suggestion).toMatch(/Rust|service host/i)
  })

  test("stdout con secretos se redacta en el diagnostic", () => {
    const d = buildDiagnostic({
      phase: "environment",
      error: "Error escribiendo .env",
      stdout: "AUTH_SECRET=abcdef0123456789abcdef0123456789 DATABASE_URL=postgres://admin:SecretPwd123@db/db",
    })
    expect(d.stdout).not.toMatch(/abcdef0123456789abcdef0123456789/)
    expect(d.stdout).not.toMatch(/SecretPwd123/)
    expect(d.stdout).toMatch(/REDACTED/)
  })

  test("stderr con secretos se redacta en el diagnostic", () => {
    const d = buildDiagnostic({
      phase: "environment",
      error: "Error",
      stderr: "Failed: adminPassword=ViewLBA-ABCD1234-7x",
    })
    expect(d.stderr).not.toMatch(/ViewLBA-ABCD1234-7x/)
    expect(d.stderr).toMatch(/REDACTED/)
  })

  test("stdout muy largo se trunca", () => {
    const d = buildDiagnostic({
      phase: "preflight",
      error: "Error",
      stdout: "x".repeat(10000),
    })
    expect(d.stdout?.length).toBeLessThan(5000)
    expect(d.stdout).toMatch(/truncated/)
  })
})

describe("renderDiagnostic: output en formato misión §2", () => {
  test("renderiza todos los campos cuando están presentes", () => {
    const d = buildDiagnostic({
      phase: "services",
      area: "STREAM SERVICE",
      error: "Port 1935 unavailable",
      command: "nssm.exe",
      argv: ["start", "ViewLBAStream"],
      cwd: "C:\\ProgramData\\ViewLBA",
      exitCode: 1,
      stdout: "stdout-line",
      stderr: "stderr-line",
      timedOut: false,
      timeoutMs: 30000,
      affectedService: "ViewLBAStream",
      binaryPath: "C:\\Program Files\\ViewLBA Server\\runtime\\nssm.exe",
      runtimeVersion: "bun 1.3.14",
      logPath: "C:\\ProgramData\\ViewLBA\\logs\\stream.log",
      affectedFile: "custom.db",
    })
    const out = renderDiagnostic(d)
    expect(out).toContain("STREAM SERVICE")
    expect(out).toContain("STATUS: FAIL")
    expect(out).toContain("Port 1935 unavailable")
    expect(out).toContain("Comando:  nssm.exe")
    expect(out).toContain("Argv:")
    expect(out).toContain("Cwd:")
    expect(out).toContain("ExitCode: 1")
    expect(out).toContain("Timeout:  30000ms")
    expect(out).toContain("Servicio: ViewLBAStream")
    expect(out).toContain("Binario:")
    expect(out).toContain("Runtime:  bun 1.3.14")
    expect(out).toContain("Log:")
    expect(out).toContain("Archivo:")
    expect(out).toContain("Stdout:")
    expect(out).toContain("Stderr:")
    expect(out).toContain("Fase:     services")
  })

  test("no incluye campos opcionales cuando faltan", () => {
    const d = buildDiagnostic({
      phase: "preflight",
      error: "Sin más contexto",
    })
    const out = renderDiagnostic(d)
    expect(out).toContain("STATUS: FAIL")
    expect(out).not.toContain("Comando:")
    expect(out).not.toContain("Argv:")
    expect(out).not.toContain("Stdout:")
  })

  test("marca TIMEOUT HIT cuando timedOut=true", () => {
    const d = buildDiagnostic({
      phase: "services",
      error: "Timeout",
      timedOut: true,
      timeoutMs: 60000,
    })
    const out = renderDiagnostic(d)
    expect(out).toMatch(/Timeout:\s+HIT/)
  })
})

describe("diagnosticFromRunResult: helper desde RunResult", () => {
  test("construye diagnóstico desde un RunResult exitoso-fallido", () => {
    const d = diagnosticFromRunResult({
      phase: "services",
      area: "REALTIME",
      command: "nssm.exe",
      argv: ["start", "ViewLBARealtime"],
      cwd: "C:\\ProgramData\\ViewLBA",
      result: {
        status: 1,
        stdout: "OK",
        stderr: "Cannot start service: missing dependency",
        command: "nssm.exe start ViewLBARealtime",
      },
      timeoutMs: 30000,
      affectedService: "ViewLBARealtime",
      binaryPath: "C:\\Program Files\\ViewLBA Server\\runtime\\nssm.exe",
      runtimeVersion: "bun 1.3.14",
    })
    expect(d.exitCode).toBe(1)
    expect(d.timedOut).toBe(false)
    expect(d.stderr).toContain("Cannot start service")
    expect(d.affectedService).toBe("ViewLBARealtime")
  })

  test("detecta timeout cuando status=null", () => {
    const d = diagnosticFromRunResult({
      phase: "services",
      command: "bun.exe",
      argv: ["scripts/start.ts"],
      result: {
        status: null,
        stdout: "",
        stderr: "",
        command: "bun.exe scripts/start.ts",
      },
      timeoutMs: 60000,
    })
    expect(d.timedOut).toBe(true)
    expect(d.exitCode).toBeNull()
    expect(d.error).toMatch(/Timeout/)
  })

  test("redacta secretos del stderr del RunResult", () => {
    const d = diagnosticFromRunResult({
      phase: "environment",
      command: "bun.exe",
      argv: ["-e", "console.log('AUTH_SECRET=abcdef0123456789abcdef0123456789')"],
      result: {
        status: 1,
        stdout: "",
        stderr: "AUTH_SECRET=abcdef0123456789abcdef0123456789",
        command: "bun.exe",
      },
    })
    expect(d.stderr).not.toMatch(/abcdef0123456789abcdef0123456789/)
    expect(d.stderr).toMatch(/REDACTED/)
  })
})
