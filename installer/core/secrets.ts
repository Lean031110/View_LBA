/**
 * Generación y gestión del archivo de entorno (.env) con secretos.
 *
 * REUTILIZA la semántica ya probada de scripts/install.ts (ensureEnv) y
 * deploy/linux/install.sh:
 *  - secretos con crypto del runtime (nunca openssl externo);
 *  - DATABASE_URL ABSOLUTA (Prisma resuelve relativas contra CWD, no schema);
 *  - .env EXISTENTE: se respeta TODO; solo se AÑADEN los secretos/valores
 *    que falten (reparación conservadora) — "NO sobrescribir configuraciones
 *    existentes" (misión);
 *  - permisos 600 (best-effort en Windows);
 *  - NUNCA se imprimen los secretos.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { readEnvFile } from "../../scripts/lib/env-file"
import { writeFile600 } from "./fsx"
import type { InstallConfig, Layout } from "./types"
import { configToEnvEntries } from "./config"

/** Genera un secreto hex seguro (crypto del runtime). */
export function generateSecret(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}

export interface EnsureEnvResult {
  existed: boolean
  created: boolean
  /** Claves añadidas a un .env existente (reparación conservadora). */
  added: string[]
  /** Claves respetadas tal cual (no se tocan). */
  keptKeys: string[]
  path: string
}

/** Resultado de generar (sin escribir) el contenido completo del .env. Puro. */
export function renderEnvContent(
  config: InstallConfig,
  layout: Layout,
  secrets: { authSecret: string; realtimeToken: string },
  now = new Date()
): string {
  const entries = configToEnvEntries(config, layout)
  const lines = [
    `# ViewLBA Server — entorno de producción (generado por el installer oficial)`,
    `# ${now.toISOString()} — JAMÁS commitear este archivo (ver .gitignore)`,
    ``,
    `# --- Obligatorias (secretos) ---`,
    `AUTH_SECRET="${secrets.authSecret}"`,
    `REALTIME_TOKEN="${secrets.realtimeToken}"`,
    ``,
    `# --- Aplicación ---`,
  ]
  for (const [k, v] of entries) {
    lines.push(`${k}=${k.includes("DIR") || k === "DATABASE_URL" ? `"${v.replace(/"/g, "")}"` : v}`)
  }
  lines.push(
    ``,
    `# --- Seguridad (opcional, descomenta para ajustar) ---`,
    `# LOGIN_RATE_LIMIT_IP_MAX=12`,
    `# LOG_RETENTION_DAYS=90`,
    ``,
    `# --- Streaming (defaults sensatos; los puertos elegidos ya van arriba si difieren) ---`,
    `# HTTP_FLV_BIND=127.0.0.1`,
    ``
  )
  return lines.join("\n")
}

/**
 * Asegura que el .env del layout exista y contenga los secretos requeridos.
 *
 * - No existe → se genera completo (secrets + config).
 * - Existe → se respetan TODOS los valores; solo se añaden (append) las
 *   claves OBLIGATORIAS ausentes: AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL.
 *
 * Devuelve un informe SIN valores de secretos (solo nombres de claves).
 */
export function ensureEnvFile(config: InstallConfig, layout: Layout): EnsureEnvResult {
  const path = layout.envFile
  if (existsSync(path)) {
    const cur = readEnvFile(path) ?? {}
    const keptKeys = Object.keys(cur)
    const added: string[] = []
    const append: string[] = []
    if (!cur.AUTH_SECRET) {
      append.push(`AUTH_SECRET="${generateSecret(24)}"`)
      added.push("AUTH_SECRET")
    }
    if (!cur.REALTIME_TOKEN) {
      append.push(`REALTIME_TOKEN="${generateSecret(16)}"`)
      added.push("REALTIME_TOKEN")
    }
    if (!cur.DATABASE_URL) {
      append.push(`DATABASE_URL="${layout.dbUrl}"`)
      added.push("DATABASE_URL")
    }
    if (append.length > 0) {
      appendFileSync(
        path,
        `\n# Valores regenerados por el installer oficial — ${new Date().toISOString()} (los existentes se respetan)\n${append.join("\n")}\n`
      )
    }
    return { existed: true, created: false, added, keptKeys, path }
  }

  const secrets = { authSecret: generateSecret(24), realtimeToken: generateSecret(16) }
  const content = renderEnvContent(config, layout, secrets)
  // mkdir del padre (p. ej. /etc en layouts personalizados ya existe, pero
  // app\.env en Windows requiere app/ creado antes).
  writeFile600(path, content)
  return { existed: false, created: true, added: [], keptKeys: [], path }
}

/** Escribe un .env en una ruta arbitraria (tests / unattended dry checks). */
export function writeEnvFileForTest(path: string, content: string): void {
  writeFileSync(path, content)
}

/** ¿Tiene el .env los tres secretos obligatorios? (check, sin exponerlos). */
export function envSecretsComplete(path: string): boolean {
  const env = readEnvFile(path)
  if (!env) return false
  return Boolean(env.AUTH_SECRET && env.REALTIME_TOKEN && env.DATABASE_URL)
}
