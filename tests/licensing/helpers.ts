/**
 * Helpers de tests de licenciamiento (tests/licensing).
 * Claves E2E/efímeras generadas en runtime — NUNCA claves reales.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateLicenseKeyPair, signLicense, deriveInstallationId, deriveDiskId, buildZip, normalizeInstallPath } from "@/lib/licensing/index"
import type { InstallationIdentity, LicensePayload, SignedLicense, LicensePlan } from "@/lib/licensing/types"

export interface TestKeyPair {
  publicKey: string
  privateKey: string
}

export function makeKeyPair(): TestKeyPair {
  return generateLicenseKeyPair()
}

/** Contadores hexadecimales al FRENTE del hash (los IDs públicos usan el
 *  prefijo del hash — debe ser ÚNICO por fixture). */
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
    installPathNormalized: overrides.installPathNormalized ?? normalizeInstallPath(installPath),
    ...overrides,
  }
}

export interface TestLicenseOptions {
  customerName?: string
  plan?: LicensePlan
  days?: number
  startsAt?: Date
  deviceId?: string
  diskId?: string
  installPath?: string
  features?: Record<string, boolean>
  licenseId?: string
}

/** Licencia firmada con la clave de test, por defecto vinculada a `identity`. */
export function makeSignedLicense(identity: InstallationIdentity, key: TestKeyPair, opts: TestLicenseOptions = {}): SignedLicense {
  const startsAt = opts.startsAt ?? new Date()
  const days = opts.days ?? 365
  const payload: LicensePayload = {
    schemaVersion: 1,
    licenseId: opts.licenseId ?? `VLBA-${(++licenseCounter).toString(16).padStart(12, "0")}`,
    customerName: opts.customerName ?? "Leandro Bueno",
    plan: opts.plan ?? "annual",
    issuedAt: new Date().toISOString(),
    startsAt: startsAt.toISOString(),
    expiresAt: new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    deviceId: opts.deviceId ?? identity.installationId,
    diskId: opts.diskId ?? identity.diskId,
    installPath: opts.installPath ?? identity.installPath,
    product: "ViewLBA-Server",
    features: opts.features ?? {
      "screens.multiDisplay": true,
      "branding.customLogo": true,
      "themes.custom": true,
      "users.management": true,
      "backup.selfService": true,
      "analytics.advanced": true,
    },
  }
  const signature = signLicense(payload, key.privateKey)
  return { ...payload, signature }
}

/** ZIP de importación con license.json (+README). */
export function makeLicenseZip(license: SignedLicense): Buffer {
  return buildZip([
    { name: "license.json", data: Buffer.from(JSON.stringify(license, null, 2), "utf8") },
    { name: "README.txt", data: Buffer.from("ViewLBA — Licencia de test\n", "utf8") },
  ])
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
