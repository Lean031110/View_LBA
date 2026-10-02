/**
 * Contrato E: Configuración y env segura para hijos
 * =================================================
 *
 * MISIÓN §6 + §10:
 *   - No usar .env del repositorio en producción
 *   - No heredar entorno del padre misteriosamente
 *   - Cada child process recibe SOLO las variables que necesita
 *   - AUTH_SECRET y REALTIME_TOKEN son únicos y NO se regeneran en upgrade
 *
 * Estructura requerida:
 *   C:\ProgramData\ViewLBA\config\
 *     ├── service-host.toml   (config del host: puertos, paths, backoff)
 *     └── server.env          (env del servidor: AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL)
 *
 * El service host Rust debe:
 *   1. Leer config/service-host.toml + config/server.env al arrancar
 *   2. Construir un entorno EXPLÍCITO para cada child:
 *        - app:      AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL, PORT, MEDIA_DIR, etc.
 *        - realtime: REALTIME_TOKEN, REALTIME_PORT, REALTIME_INTERNAL_PORT
 *        - stream:   RTMP_PORT, HTTP_FLV_PORT, HTTP_FLV_BIND, MEDIA_DIR, etc.
 *   3. NO heredar env del padre salvo las variables explícitamente aprobadas
 *
 * ESTE TEST DEBE FALLAR hasta que:
 *   - Exista un template de config en el repo (config/service-host.toml.example)
 *   - El supervisor.rs tenga un método que cargue la config de ProgramData
 *   - El supervisor.rs pase env EXPLÍCITO a Command::new (no heredado)
 */
import { describe, test, expect } from "bun:test"
import { readRepoFile, readRepoDir, walkAndCollect, REPO_ROOT } from "./_helpers"
import { existsSync } from "node:fs"
import { join } from "node:path"

describe("CONTRATO E: Configuración y env segura para hijos", () => {
  test("EXISTS: config/service-host.toml.example template", () => {
    const path = "config/service-host.toml.example"
    let exists = false
    try {
      readRepoFile(path)
      exists = true
    } catch {
      exists = false
    }
    expect(exists).toBe(true)
  })

  test("EXISTS: config/server.env.example template", () => {
    const path = "config/server.env.example"
    let exists = false
    try {
      readRepoFile(path)
      exists = true
    } catch {
      exists = false
    }
    expect(exists).toBe(true)
  })

  test("server.env.example declara TODAS las variables requeridas", () => {
    let content = ""
    try {
      content = readRepoFile("config/server.env.example")
    } catch {
      // file doesn't exist → test fails (expected for now)
    }
    const requiredVars = [
      "PORT",
      "DATABASE_URL",
      "TIMEZONE",
      "MEDIA_DIR",
      "BACKUP_DIR",
      "LOG_DIR",
      "REALTIME_PORT",
      "REALTIME_INTERNAL_PORT",
      "RTMP_PORT",
      "HTTP_FLV_PORT",
      "HTTP_FLV_BIND",
      "AUTH_SECRET",
      "REALTIME_TOKEN",
    ]
    for (const v of requiredVars) {
      expect(content).toContain(v)
    }
  })

  test("server.env.example NO tiene valores hardcodeados de secretos", () => {
    let content = ""
    try {
      content = readRepoFile("config/server.env.example")
    } catch {
      // file doesn't exist
    }
    // No debe tener valores como 'changeme', 'secret123', 'demo', etc.
    expect(content).not.toMatch(/changeme|secret123|demo.*token/i)
    // AUTH_SECRET debe tener placeholder como <GENERATED_BY_INSTALLER> o similar
    const authLine = content.match(/AUTH_SECRET=.*/)?.[0] ?? ""
    if (authLine) {
      expect(authLine).toMatch(/<.*GENERATED|<.*INSTALLER|<.*TODO|__.*__/)
    }
  })

  test("supervisor.rs CARGA config de ProgramData (no hardcoded)", () => {
    const sup = readRepoFile("installer/native/windows-service/src/supervisor.rs")
    // Debe haber mención a ProgramData\config\ o service-host.toml
    expect(sup).toMatch(/program_data.*config|service-host\.toml/i)
  })

  test("supervisor.rs CONSTRUYE env explícito para cada child", () => {
    const sup = readRepoFile("installer/native/windows-service/src/supervisor.rs")
    // Debe haber uso de Command::new().env(...) o .env_clear() para NO heredar
    expect(sup).toMatch(/\.env\(|\.env_clear\(|env_clear/)
  })

  test("supervisor.rs NO pasa AUTH_SECRET vía argv (solo env)", () => {
    const sup = readRepoFile("installer/native/windows-service/src/supervisor.rs")
    // Buscar en las llamadas a spawn_child — no debe pasar AUTH_SECRET como string
    // argv debe ser solo ["scripts/start.ts"] o ["mini-services/.../index.ts"]
    // (no tokens embebidos)
    const argvLines = sup.split("\n").filter(l => l.includes("vec!["))
    for (const line of argvLines) {
      expect(line).not.toMatch(/AUTH_SECRET|REALTIME_TOKEN/i)
    }
  })

  test("secrets.ts GENERA secretos únicos (RNG crypto, no fallback)", () => {
    const secrets = readRepoFile("installer/core/secrets.ts")
    expect(secrets).toMatch(/randomBytes/)
    // No debe haber fallbacks hardcoded
    expect(secrets).not.toMatch(/changeme|secret123|ViewLBA-CambioYa1/i)
  })

  test("secrets.ts NO REGENERA secretos si ya existen (upgrade-safe)", () => {
    const secrets = readRepoFile("installer/core/secrets.ts")
    // ensureEnvFile debe respetar .env existente
    expect(secrets).toMatch(/existsSync|existed.*true|respect.*existing|conservar/i)
  })
})
