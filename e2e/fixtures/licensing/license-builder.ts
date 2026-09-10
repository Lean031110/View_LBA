/**
 * E2E fixtures — constructor de licencias firmadas para tests.
 *
 * Reutiliza el MISMO código canónico de firma del producto (src/lib/licensing)
 * → si el generador/verificador divergen, los E2E lo detectan.
 */
import { signLicense, newLicenseId, buildZip, normalizeInstallPath } from "../../../src/lib/licensing/index"
import type { LicensePayload, SignedLicense } from "../../../src/lib/licensing/types"
import { E2E_LICENSE_PRIVATE_KEY, E2E_INSTALLATION_ID, E2E_DISK_ID, E2E_INSTALL_PATH } from "./keys"

export interface E2eLicenseOptions {
  customerName?: string
  plan?: "monthly" | "annual"
  startsAt?: Date
  days?: number
  deviceId?: string
  diskId?: string
  installPath?: string
  licenseId?: string
  features?: Record<string, boolean>
}

/** Construye una licencia firmada con la clave DUMMY de E2E. */
export function buildE2eLicense(opts: E2eLicenseOptions = {}): SignedLicense {
  const startsAt = opts.startsAt ?? new Date()
  const days = opts.days ?? 365
  const expiresAt = new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000)
  const payload: LicensePayload = {
    schemaVersion: 1,
    licenseId: opts.licenseId ?? newLicenseId(),
    customerName: opts.customerName ?? "Restaurante E2E",
    plan: opts.plan ?? "annual",
    issuedAt: new Date().toISOString(),
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    deviceId: opts.deviceId ?? E2E_INSTALLATION_ID,
    diskId: opts.diskId ?? E2E_DISK_ID,
    installPath: normalizeInstallPath(opts.installPath ?? E2E_INSTALL_PATH),
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
  const signature = signLicense(payload, E2E_LICENSE_PRIVATE_KEY)
  return { ...payload, signature }
}

/** ZIP de licencia listo para importar (license.json + README.txt). */
export function buildE2eLicenseZip(license: SignedLicense): Buffer {
  return buildZip([
    { name: "license.json", data: Buffer.from(JSON.stringify(license, null, 2), "utf8") },
    {
      name: "README.txt",
      data: Buffer.from(
        [
          "ViewLBA — Licencia (E2E TEST)",
          `Cliente: ${license.customerName}`,
          `Plan: ${license.plan}`,
          `Vence: ${license.expiresAt}`,
          "",
          "Fixture de test — no es una licencia real.",
        ].join("\n"),
        "utf8"
      ),
    },
  ])
}

/** ZIP con license.json manipulado (rompe la firma). */
export function buildTamperedE2eLicenseZip(field: "customerName" | "expiresAt" | "plan", value: string): Buffer {
  const license = buildE2eLicense()
  const tampered = { ...license, [field]: value }
  return buildZip([{ name: "license.json", data: Buffer.from(JSON.stringify(tampered, null, 2), "utf8") }])
}
