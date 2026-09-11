/**
 * Helpers de tests de licenciamiento v2 (tests/licensing).
 * Claves E2E/efímeras generadas en runtime — NUNCA claves reales.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateLicenseKeyPair, generateRequestKeyPair, randomHex } from "@/lib/licensing/crypto"
import { buildLicenseToken } from "@/lib/licensing/token"
import { deriveInstallationId } from "@/lib/licensing/fingerprint"
import { deriveDiskId, DISK_ID_RE } from "@/lib/licensing/disk-binding"
import type { InstallationIdentity, LicensePlan, LicenseTokenPayload } from "@/lib/licensing/types"

export interface TestKeyPair {
  publicKey: string
  privateKey: string
}

export function makeKeyPair(): TestKeyPair {
  return generateLicenseKeyPair()
}

/** Par X25519 (apertura de códigos de solicitud) para tests. */
export function makeRequestKeyPair(): TestKeyPair {
  return generateRequestKeyPair()
}

/** Contadores hexadecimales al FRENTE del hash (los IDs públicos usan el
 * prefijo del hash — debe ser ÚNICO por fixture). */
let counter = 0
let licenseCounter = 0
function uniqueHex64(fill: string): string {
  counter += 1
  return counter.toString(16).padStart(2, "0") + fill.repeat(62)
}

/** Identidad sintética estable para tests (hashes hex de 64). */
export function makeIdentity(overrides: Partial<InstallationIdentity> = {}): InstallationIdentity {
  const deviceIdHash = overrides.deviceIdHash ?? uniqueHex64("e")
  const diskIdHash = overrides.diskIdHash ?? uniqueHex64("d")
  const installPath = overrides.installPath ?? "C:\\PantallaRestaurante"
  return {
    deviceIdHash,
    installationId: overrides.installationId ?? deriveInstallationId(deviceIdHash),
    fingerprintMethod: overrides.fingerprintMethod ?? "machine-id",
    diskIdHash,
    diskId: overrides.diskId ?? deriveDiskId(diskIdHash),
    diskLabel: overrides.diskLabel ?? "C:",
    diskBindingMethod: overrides.diskBindingMethod ?? "vol-serial",
    installPath,
    ...overrides,
  }
}

export const ALL_FEATURES_ON: Record<string, boolean> = {
  "display.watermark": false,
  "screens.multiDisplay": true,
  "branding.customLogo": true,
  "themes.custom": true,
  "users.management": true,
  "backup.selfService": true,
  "analytics.advanced": true,
}

export interface TestTokenOptions {
  customerName?: string
  plan?: LicensePlan
  durationDays?: number
  startsAt?: Date
  installationId?: string
  diskId?: string
  features?: Record<string, boolean>
  licenseId?: string
  nonce?: string
  issuedAt?: number
}

let lastPayload: LicenseTokenPayload | null = null

/** Payload del token vinculado por defecto a `identity`. */
export function makeTokenPayload(identity: InstallationIdentity, opts: TestTokenOptions = {}): LicenseTokenPayload {
  const startsAt = opts.startsAt ?? new Date()
  const durationDays = opts.durationDays ?? (opts.plan === "monthly" ? 30 : opts.plan === "annual" ? 365 : opts.durationDays ?? 365)
  const plan: LicensePlan = opts.plan ?? (durationDays === 30 ? "monthly" : durationDays === 365 ? "annual" : "custom")
  const payload: LicenseTokenPayload = {
    v: 2,
    licenseId: opts.licenseId ?? `VLBA-${(++licenseCounter).toString(16).padStart(12, "0")}`,
    customerName: opts.customerName ?? "Lo D'Leo",
    plan,
    durationDays,
    product: "ViewLBA-Server",
    // Emitido en min(ahora, inicio): coherente tanto con licencias futuras
    // (emitidas hoy, empiezan después) como con startsAt en el pasado.
    issuedAt: opts.issuedAt ?? Math.min(Date.now(), startsAt.getTime()),
    startsAt: startsAt.getTime(),
    expiresAt: startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000,
    installationId: opts.installationId ?? identity.installationId,
    diskId: opts.diskId ?? identity.diskId,
    features: opts.features ?? ALL_FEATURES_ON,
    nonce: opts.nonce ?? randomHex(16),
  }
  lastPayload = payload
  return payload
}

/** Token VLBA2 firmado con la clave de test, vinculado por defecto a `identity`. */
export function makeLicenseToken(identity: InstallationIdentity, key: TestKeyPair, opts: TestTokenOptions = {}): string {
  return buildLicenseToken(makeTokenPayload(identity, opts), key.privateKey)
}

/** Último payload construido por makeTokenPayload (inspección en tests). */
export function lastTokenPayload(): LicenseTokenPayload | null {
  return lastPayload
}

/** Directorio temporal con 2 anclas de trial (como producción). */
export function makeAnchorPaths(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "viewlba-license-test-"))
  return [join(dir, "licensing", "state.json"), join(dir, "home", ".viewlba-license.json")]
}

export function cleanupAnchorPaths(paths: string[]): void {
  const dirs = new Set(paths.map((p) => p.split("/").slice(0, -2).join("/")).filter((d) => d.includes("viewlba-license-test-")))
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

export const DAY_MS = 24 * 60 * 60 * 1000

export { DISK_ID_RE }
