/**
 * E2E fixtures — constructor de tokens VLBA2 firmados para tests.
 *
 * Reutiliza el MISMO código de firma del producto (src/lib/licensing) → si
 * el emisor de referencia y el verificador divergen, los E2E lo detectan.
 */
import { buildLicenseToken } from "../../../src/lib/licensing/token"
import { openRequestCode } from "../../../src/lib/licensing/request-code"
import type { LicenseTokenPayload } from "../../../src/lib/licensing/types"
import { E2E_LICENSE_PRIVATE_KEY, E2E_REQUEST_PRIVATE_KEY, E2E_INSTALLATION_ID, E2E_DISK_ID } from "./keys"

export interface E2eTokenOptions {
  customerName?: string
  plan?: "monthly" | "annual" | "custom"
  durationDays?: number
  startsAt?: number
  installationId?: string
  diskId?: string
  features?: Record<string, boolean>
  licenseId?: string
  nonce?: string
}

/** Construye un token VLBA2 firmado con la clave DUMMY de E2E. */
export function buildE2eLicenseToken(opts: E2eTokenOptions = {}): string {
  const durationDays = opts.durationDays ?? 365
  const plan = opts.plan ?? (durationDays === 30 ? "monthly" : durationDays === 365 ? "annual" : "custom")
  const startsAt = opts.startsAt ?? Date.now()
  const payload: LicenseTokenPayload = {
    v: 2,
    licenseId: opts.licenseId ?? `VLBA-${(globalThis.crypto.randomUUID().replace(/-/g, "")).slice(0, 12)}`,
    customerName: opts.customerName ?? "Restaurante E2E",
    plan,
    durationDays,
    product: "ViewLBA-Server",
    issuedAt: Math.min(Date.now(), startsAt),
    startsAt,
    expiresAt: startsAt + durationDays * 24 * 60 * 60 * 1000,
    installationId: opts.installationId ?? E2E_INSTALLATION_ID,
    diskId: opts.diskId ?? E2E_DISK_ID,
    features: opts.features ?? {
      "screens.multiDisplay": true,
      "branding.customLogo": true,
      "themes.custom": true,
      "users.management": true,
      "backup.selfService": true,
      "analytics.advanced": true,
    },
    nonce: opts.nonce ?? (globalThis.crypto.randomUUID().replace(/-/g, "")).slice(0, 32),
  }
  return buildLicenseToken(payload, E2E_LICENSE_PRIVATE_KEY)
}

/** "Emisor Android" de E2E: abre un código VLREQ2 con la clave X25519 DUMMY. */
export function openE2eRequestCode(code: string) {
  return openRequestCode(code, E2E_REQUEST_PRIVATE_KEY, {})
}
