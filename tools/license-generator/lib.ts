/**
 * ViewLBA License Generator — lógica compartida del CLI (sección 6/7/18).
 *
 * ⚠ Este tool vive SEPARADO de la app del cliente: posee/consume la clave
 *   PRIVADA de firma (env VIEWLBA_LICENSE_PRIVATE_KEY o --private-key-file).
 *   JAMAS: commit de claves, claves dentro de la app, claves en artifacts.
 *
 * Reutiliza el código canónico del producto (src/lib/licensing) → firma y
 * verificación comparten EXACTAMENTE la misma canonicalización.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  signLicense,
  verifyLicenseSignature,
  generateLicenseKeyPair,
  newLicenseId,
  buildZip,
  readZip,
  findZipEntry,
  canonicalizeLicensePayload,
  stripSignature,
  normalizeInstallPath,
  INSTALLATION_ID_RE,
  DISK_ID_RE,
} from "../../src/lib/licensing/index"
import type { LicensePayload, SignedLicense, LicensePlan } from "../../src/lib/licensing/types"
import { PLAN_DURATION_DAYS, PLAN_PRICE_USD, CONTACT_PHONE } from "../../src/lib/licensing/types"

export const GENERATOR_VERSION = "1.0.0"
export const TOOL_DIR = import.meta.dir
export const HISTORY_DIR = join(TOOL_DIR, "history")
export const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl")
export const DEFAULT_OUT_DIR = join(TOOL_DIR, "out")

export interface GenerateInput {
  customerName: string
  installationId: string
  diskId: string
  installPath: string
  plan: LicensePlan
  /** YYYY-MM-DD (default: hoy). */
  startDate: string
  /** Features explícitas (opcional — default: todas del plan). */
  features?: Record<string, boolean>
  licenseId?: string
  issuedAt?: Date
}

export interface GenerateResult {
  license: SignedLicense
  zipPath: string
  zipBuffer: Buffer
  readme: string
}

// ---------------------------------------------------------------------------
// Validaciones de entrada (sección 6: validar ANTES de crear)
// ---------------------------------------------------------------------------

export function validateGenerateInput(input: Partial<GenerateInput>): string[] {
  const errors: string[] = []

  const name = (input.customerName ?? "").trim()
  if (!name) errors.push("El nombre del cliente no puede estar vacío")
  else if (name.length > 200) errors.push("El nombre del cliente es demasiado largo (máx. 200)")

  const installId = (input.installationId ?? "").trim().toUpperCase()
  if (!INSTALLATION_ID_RE.test(installId)) {
    errors.push(`Installation ID inválido: se esperaba formato VWLB-XXXX-XXXX-XXXX-XXXX (ej. VWLB-8F2A-91CD-2D31-77AA)`)
  }

  const diskId = (input.diskId ?? "").trim().toUpperCase()
  if (!DISK_ID_RE.test(diskId)) {
    errors.push(`Disk ID inválido: se esperaba formato DSK-XXXX-XXXX-XXXX (lo envía el cliente desde Administración → Licencia)`)
  }

  const path = (input.installPath ?? "").trim()
  if (!path) errors.push("La ruta de instalación no puede estar vacía")
  else if (path.length > 500) errors.push("La ruta de instalación es demasiado larga")

  if (input.plan !== "monthly" && input.plan !== "annual") {
    errors.push("Plan inválido: usa monthly (30 días, USD 10) o annual (365 días, USD 100)")
  }

  const start = (input.startDate ?? "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    errors.push("Fecha de inicio inválida: usa formato YYYY-MM-DD (ej. 2026-09-10)")
  } else {
    const d = new Date(`${start}T00:00:00.000Z`)
    if (Number.isNaN(d.getTime())) errors.push("Fecha de inicio ilegible")
    // start < expiry se garantiza por duración > 0 del plan, pero validamos
    // que start no sea absurdo (más de 1 año en el pasado)
    else if (Date.now() - d.getTime() > 366 * 24 * 3600 * 1000) errors.push("Fecha de inicio demasiado antigua (más de 1 año en el pasado)")
  }

  if (input.features) {
    for (const [k, v] of Object.entries(input.features)) {
      if (typeof v !== "boolean") errors.push(`Feature "${k}" debe ser boolean`)
      if (!/^[a-z][a-zA-Z0-9.]*$/.test(k)) errors.push(`Feature con nombre inválido: "${k}"`)
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Clave privada (NUNCA se commitea; env o archivo fuera del repo)
// ---------------------------------------------------------------------------

export function loadPrivateKey(cliFile?: string): { key: string; source: string } {
  const fromEnv = process.env.VIEWLBA_LICENSE_PRIVATE_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: "env VIEWLBA_LICENSE_PRIVATE_KEY" }
  if (cliFile) {
    const abs = resolve(cliFile)
    if (!existsSync(abs)) throw new Error(`No existe el archivo de clave privada: ${abs}`)
    const key = readFileSync(abs, "utf8").trim()
    if (!key) throw new Error(`El archivo de clave privada está vacío: ${abs}`)
    return { key, source: `archivo ${abs}` }
  }
  throw new Error(
    "Falta la clave privada de firma.\n" +
      "  · Env:      export VIEWLBA_LICENSE_PRIVATE_KEY=\"<base64url>\"\n" +
      "  · Archivo:  --private-key-file /ruta/segura/viewlba-private.key\n" +
      "  · Generar:  bun tools/license-generator/cli.ts keys"
  )
}

// ---------------------------------------------------------------------------
// Construcción de la licencia + ZIP + README
// ---------------------------------------------------------------------------

export const ALL_FEATURES: Record<string, boolean> = {
  "screens.multiDisplay": true,
  "branding.customLogo": true,
  "themes.custom": true,
  "users.management": true,
  "backup.selfService": true,
  "analytics.advanced": true,
}

/** Slug para el nombre de archivo: "Leandro Bueno" → "Leandro-Bueno". */
export function slugifyCustomer(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "Cliente"
}

export function buildLicense(input: GenerateInput, privateKey: string): SignedLicense {
  const start = new Date(`${input.startDate}T00:00:00.000Z`)
  const durationDays = PLAN_DURATION_DAYS[input.plan]
  const end = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000)

  const payload: LicensePayload = {
    schemaVersion: 1,
    licenseId: input.licenseId ?? newLicenseId(),
    customerName: input.customerName.trim(),
    plan: input.plan,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
    startsAt: start.toISOString(),
    expiresAt: end.toISOString(),
    deviceId: input.installationId.trim().toUpperCase(),
    diskId: input.diskId.trim().toUpperCase(),
    installPath: normalizeInstallPath(input.installPath.trim()),
    product: "ViewLBA-Server",
    features: input.features ?? { ...ALL_FEATURES },
  }
  const signature = signLicense(payload, privateKey)
  return { ...payload, signature }
}

export function buildReadme(license: SignedLicense): string {
  const planLabel = license.plan === "annual" ? `Anual (365 días · USD ${PLAN_PRICE_USD.annual})` : `Mensual (30 días · USD ${PLAN_PRICE_USD.monthly})`
  return [
    "================================================================",
    "  ViewLBA — LICENCIA DE USO",
    "================================================================",
    "",
    `Cliente:            ${license.customerName}`,
    `Plan:               ${planLabel}`,
    `Inicio de vigencia: ${license.startsAt.slice(0, 10)}`,
    `Vencimiento:        ${license.expiresAt.slice(0, 10)}`,
    "",
    "----------------------------------------------------------------",
    "  INSTALACIÓN VINCULADA (no funciona en otro equipo/disco)",
    "----------------------------------------------------------------",
    `Installation ID:    ${license.deviceId}`,
    `Disk ID:            ${license.diskId}`,
    `Ruta de instalación:${license.installPath}`,
    `Licencia:           ${license.licenseId}`,
    "",
    "----------------------------------------------------------------",
    "  CÓMO IMPORTAR",
    "----------------------------------------------------------------",
    "1. Abre ViewLBA en el SERVIDOR del restaurante.",
    "2. Entra al panel: Administración → Licencia.",
    "3. Pulsa IMPORTAR LICENCIA y selecciona este archivo ZIP.",
    "4. Si todo es correcto verás: ✓ Licencia válida (equipo y disco",
    "   vinculados) y la marca de agua de la pantalla TV desaparecerá.",
    "",
    "⚠ IMPORTANTE",
    "  · No modifiques este ZIP: cualquier cambio invalida la firma digital.",
    "  · La licencia está vinculada al equipo y disco indicados arriba.",
    "    Si cambias de equipo/disco, solicita una nueva licencia.",
    "",
    `Soporte y renovaciones: ${CONTACT_PHONE}`,
    "",
    "================================================================",
    "",
  ].join("\n")
}

export interface ZipOptions {
  outDir?: string
  /** Fecha usada en el nombre del archivo (default: startDate). */
  fileDate?: string
  /** Sobrescribir si ya existe (default: false — sección 6). */
  force?: boolean
}

export function zipFileName(license: SignedLicense): string {
  return `ViewLBA-License-${slugifyCustomer(license.customerName)}-${license.startsAt.slice(0, 10).replace(/-/g, "")}.zip`
}

export function generateLicenseZip(input: GenerateInput, privateKey: string, opts: ZipOptions = {}): GenerateResult {
  const license = buildLicense(input, privateKey)

  // Verificación INMEDIATA de ida y vuelta (nunca entregar una licencia
  // firmada que el verificador no acepte)
  const publicKey = process.env.VIEWLBA_LICENSE_PUBLIC_KEY?.trim()
  if (publicKey && !verifyLicenseSignature(license, publicKey)) {
    throw new Error("AUTO-VERIFICACIÓN FALLÓ: la licencia firmada no pasa la verificación con VIEWLBA_LICENSE_PUBLIC_KEY — revisa el par de claves")
  }

  const readme = buildReadme(license)
  const zipBuffer = buildZip([
    { name: "license.json", data: Buffer.from(JSON.stringify(license, null, 2), "utf8") },
    { name: "README.txt", data: Buffer.from(readme, "utf8") },
  ])

  const outDir = resolve(opts.outDir ?? DEFAULT_OUT_DIR)
  mkdirSync(outDir, { recursive: true })
  const zipPath = join(outDir, zipFileName(license))
  if (existsSync(zipPath) && !opts.force) {
    throw new Error(`Ya existe ${zipPath} — usa --force para sobrescribir (sección 6: no sobrescribir accidentalmente)`)
  }
  writeFileSync(zipPath, zipBuffer)

  return { license, zipPath, zipBuffer, readme }
}

// ---------------------------------------------------------------------------
// Historial local de emisión (sección 25 — NUNCA la clave privada)
// ---------------------------------------------------------------------------

export interface HistoryRecord {
  ts: string
  licenseId: string
  customerName: string
  installationId: string
  diskId: string
  plan: string
  issuedAt: string
  startsAt: string
  expiresAt: string
  file: string
  generatorVersion: string
}

export function appendHistory(record: HistoryRecord): void {
  mkdirSync(HISTORY_DIR, { recursive: true })
  appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf8")
}

export function readHistory(limit = 50): HistoryRecord[] {
  if (!existsSync(HISTORY_FILE)) return []
  return readFileSync(HISTORY_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryRecord)
    .slice(-limit)
    .reverse()
}

// ---------------------------------------------------------------------------
// Lectura de licencias existentes (renew/verify)
// ---------------------------------------------------------------------------

/** Lee una licencia desde license.json o ZIP (para renovar/verificar). */
export function readLicenseFile(path: string): SignedLicense {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`No existe: ${abs}`)
  const buf = readFileSync(abs)

  let jsonText: string
  if (abs.toLowerCase().endsWith(".zip")) {
    const entries = readZip(buf)
    const entry = findZipEntry(entries, "license.json")
    if (!entry) throw new Error("El ZIP no contiene license.json")
    jsonText = entry.data.toString("utf8")
  } else {
    jsonText = buf.toString("utf8")
  }
  const parsed = JSON.parse(jsonText) as SignedLicense
  if (!parsed?.signature || !parsed?.deviceId) throw new Error("El archivo no parece una licencia ViewLBA")
  return parsed
}

/** Verifica la firma de una licencia con una clave pública dada. */
export function verifyWithKey(license: SignedLicense, publicKey: string): boolean {
  return verifyLicenseSignature(license, publicKey)
}

/** Payload canónico (para inspección/verificación manual). */
export function canonicalOf(license: SignedLicense): string {
  return canonicalizeLicensePayload(stripSignature(license as unknown as Record<string, unknown>))
}

export { generateLicenseKeyPair, CONTACT_PHONE, PLAN_DURATION_DAYS, PLAN_PRICE_USD }
