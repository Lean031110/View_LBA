/**
 * Genera VECTORES DORADOS de compatibilidad TypeScript (servidor) ↔ Kotlin
 * (app Android android-license-generator). Los valores esperados se embeben
 * en CrossCompatTest (JVM) para garantizar que ambas implementaciones
 * producen EXACTAMENTE los mismos bytes (JSON canónico, Base32, CRC32,
 * token VLBA2 firmado, código VLREQ2 sellado).
 *
 * Uso: bun scripts/gen-golden-vectors.ts   (desde la raíz del repo)
 */
import { createPrivateKey, createPublicKey } from "node:crypto"
import { canonicalize } from "../src/lib/licensing/canonical"
import { base32Encode, crc32 } from "../src/lib/licensing/codec"
import { buildLicenseToken } from "../src/lib/licensing/token"
import { buildRequestCode, openRequestCode } from "../src/lib/licensing/request-code"
import type { LicenseTokenPayload } from "../src/lib/licensing/types"

const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex")
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex")
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex")
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex")

// Semillas FIJAS (solo test — nunca usar en producción)
const edSeed = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex")
const xSeed = Buffer.from("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210", "hex")

// ⚠ Bun/Node: generateKeyPairSync({privateKey}) NO deriva la pública correcta
// para X25519/Ed25519 — la pública correcta se obtiene con createPrivateKey→createPublicKey.
const edPrivObj = createPrivateKey({ key: Buffer.concat([ED_PKCS8, edSeed]), format: "der", type: "pkcs8" })
const edPubB64 = (createPublicKey(edPrivObj).export({ format: "der", type: "spki" }) as Buffer).subarray(ED_SPKI.length).toString("base64url")
const xPrivObj = createPrivateKey({ key: Buffer.concat([X_PKCS8, xSeed]), format: "der", type: "pkcs8" })
const xRequestPub = (createPublicKey(xPrivObj).export({ format: "der", type: "spki" }) as Buffer).subarray(X_SPKI.length).toString("base64url")

const out: string[] = []
out.push("// === VECTORES DORADOS (scripts/gen-golden-vectors.ts) ===")

const payloadObj = {
  nonce: "0123456789abcdef", features: { "users.management": true }, diskId: "DSK-A5ED-432A-37DD",
  installationId: "VWLB-0094-6114-A3A4-8905", expiresAt: 1759660800000, startsAt: 1757068800000,
  issuedAt: 1757068800000, product: "ViewLBA-Server", durationDays: 30, plan: "monthly",
  customerName: "Lo D'Leo", licenseId: "VLBA-aaaaaaaaaaaa", v: 2,
} as Record<string, unknown>
out.push(`CANONICAL1=${canonicalize(payloadObj)}`)
out.push(`BASE32_FOOBAR=${base32Encode(Buffer.from("foobar", "utf8"))}`)
out.push(`BASE32_BYTES=${base32Encode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]))}`)
out.push(`CRC32_123456789=${crc32(Buffer.from("123456789", "utf8"))}`)
out.push(`CRC32_FOOBAR=${crc32(Buffer.from("foobar", "utf8"))}`)

const payload: LicenseTokenPayload = {
  v: 2, licenseId: "VLBA-aaaaaaaaaaaa", customerName: "Lo D'Leo", plan: "monthly", durationDays: 30,
  product: "ViewLBA-Server", issuedAt: 1757068800000, startsAt: 1757068800000, expiresAt: 1759660800000,
  installationId: "VWLB-0094-6114-A3A4-8905", diskId: "DSK-A5ED-432A-37DD",
  features: { "users.management": true }, nonce: "0123456789abcdef",
}
const edPrivB64 = edSeed.toString("base64url")
const token = buildLicenseToken(payload, edPrivB64)
out.push(`ED_SEED_B64=${edPrivB64}`)
out.push(`ED_PUB_B64=${edPubB64}`)
out.push(`VLBA2_TOKEN=${token}`)

const now = 1757068800000
const code = buildRequestCode({
  customerName: "Lo D'Leo", installationId: "VWLB-0094-6114-A3A4-8905", diskId: "DSK-A5ED-432A-37DD",
  now, nonce: "0123456789abcdef", requestPublicKey: xRequestPub,
})
out.push(`X25519_SEED_B64=${xSeed.toString("base64url")}`)
out.push(`X25519_PUB_B64=${xRequestPub}`)
out.push(`VLREQ2_CODE=${code}`)
const opened = openRequestCode(code, xSeed.toString("base64url"), { now })
out.push(`VLREQ2_OPENS=${opened.payload.customerName === "Lo D'Leo"}`)

console.log(out.join("\n"))
if (opened.payload.customerName !== "Lo D'Leo") {
  console.error("✗ El vector VLREQ2 no abre correctamente")
  process.exit(1)
}
