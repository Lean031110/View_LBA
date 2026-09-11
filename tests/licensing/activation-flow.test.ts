/**
 * Tests: flujo completo de ACTIVACIÓN por token (activateLicenseToken).
 *
 * Cubre: activación válida (monthly/annual/custom), re-activación
 * idempotente, duplicado por licenseId, anti-downgrade, renovación,
 * binding, vigencia, token vacío/truncado, DB corrupta, feature gating y
 * código de solicitud desde la fachada.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { activateLicenseToken, getLicenseSystemState, buildLicenseRequestCode, openRequestCode } from "@/lib/licensing/index"
import { buildLicenseToken, decodeLicenseToken } from "@/lib/licensing/token"
import { buildTokenFrame, base32Encode, formatWithDashes } from "@/lib/licensing/codec"
import { MemoryLicenseStore } from "@/lib/licensing/storage"
import { generateLicenseKeyPair, generateRequestKeyPair } from "@/lib/licensing/crypto"
import { makeIdentity, makeLicenseToken, makeTokenPayload, makeAnchorPaths, cleanupAnchorPaths, DAY_MS, ALL_FEATURES_ON } from "./helpers"

let identity: ReturnType<typeof makeIdentity>
let key: ReturnType<typeof generateLicenseKeyPair>
let reqKey: ReturnType<typeof generateRequestKeyPair>
let store: MemoryLicenseStore
let anchors: string[]
const opts = () => ({ store, identity, anchorPaths: anchors, silent: true, publicKey: key.publicKey })

beforeEach(() => {
  identity = makeIdentity()
  key = generateLicenseKeyPair()
  reqKey = generateRequestKeyPair()
  store = new MemoryLicenseStore()
  anchors = makeAnchorPaths()
  process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdef"
})

afterEach(() => {
  cleanupAnchorPaths(anchors)
})

describe("activación — happy path", () => {
  it("licencia válida de 365 días (Lo D'Leo) → ok + summary + persistencia", async () => {
    const token = makeLicenseToken(identity, key, { customerName: "Lo D'Leo", plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })

    expect(res.ok).toBe(true)
    expect(res.summary?.customerName).toBe("Lo D'Leo")
    expect(res.summary?.plan).toBe("annual")
    expect(res.summary?.durationDays).toBe(365)
    expect(res.summary?.daysLeft).toBe(365)

    const record = await store.getLicenseRecord()
    expect(record?.token).toBeTruthy()
    expect(record?.payload.licenseId).toMatch(/^VLBA-[0-9a-f]{12}$/)
    expect(store.history).toHaveLength(1)
    expect(store.history[0].current).toBe(true)
    expect(store.history[0].customerName).toBe("Lo D'Leo")
  })

  it("22 · licencia mensual (30 días) → ok", async () => {
    const token = makeLicenseToken(identity, key, { plan: "monthly", durationDays: 30 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(true)
    expect(res.summary?.plan).toBe("monthly")
    expect(res.summary?.daysLeft).toBe(30)
    const state = await getLicenseSystemState(opts())
    expect(state.status).toBe("active")
    expect(state.license?.plan).toBe("monthly")
  })

  it("23 · licencia anual (365 días) → ok", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(true)
    expect(res.summary?.durationDays).toBe(365)
  })

  it("24 · duración personalizada (45 días, plan custom) → ok", async () => {
    const token = makeLicenseToken(identity, key, { plan: "custom", durationDays: 45 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(true)
    expect(res.summary?.plan).toBe("custom")
    expect(res.summary?.durationDays).toBe(45)
    const state = await getLicenseSystemState(opts())
    expect(state.daysLeft).toBe(45)
  })

  it("25 · feature gating tras activar: premium ON, watermark OFF", async () => {
    const before = await getLicenseSystemState(opts())
    expect(before.status).toBe("trial")
    expect(before.features.watermark).toBe(true)

    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(token, { ...opts() })

    const after = await getLicenseSystemState(opts())
    expect(after.status).toBe("active")
    expect(after.features.watermark).toBe(false)
    expect(after.features.flags["users.management"]).toBe(true)
    expect(after.features.flags["themes.custom"]).toBe(true)
    expect(after.trial).toBeNull() // con licencia activa no se reporta trial
  })

  it("features restringidas del token se respetan (override del plan)", async () => {
    const features = { ...ALL_FEATURES_ON, "users.management": false }
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365, features })
    await activateLicenseToken(token, { ...opts() })
    const state = await getLicenseSystemState(opts())
    expect(state.features.flags["users.management"]).toBe(false)
    expect(state.features.flags["themes.custom"]).toBe(true)
  })
})

describe("anti-replay / duplicados", () => {
  it("re-activar el MISMO token → idempotente (alreadyActive, sin duplicar historial)", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    const first = await activateLicenseToken(token, { ...opts() })
    const second = await activateLicenseToken(token, { ...opts() })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.alreadyActive).toBe(true)
    expect(store.history).toHaveLength(1)
  })

  it("re-activar el mismo token CON guiones/espacios distintos → también idempotente", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(token, { ...opts() })
    const messy = (token.match(/.{1,17}/g) ?? []).join("\n")
    const second = await activateLicenseToken(messy, { ...opts() })
    expect(second.ok).toBe(true)
    expect(second.alreadyActive).toBe(true)
  })

  it("otro token con el MISMO licenseId → duplicate_license", async () => {
    const payloadA = makeTokenPayload(identity, { plan: "annual", durationDays: 365, licenseId: "VLBA-abcdef000001" })
    const payloadB = makeTokenPayload(identity, { plan: "annual", durationDays: 365, licenseId: "VLBA-abcdef000001", nonce: "ffffffffffffffff" })
    const tokenA = buildLicenseToken(payloadA, key.privateKey)
    const tokenB = buildLicenseToken(payloadB, key.privateKey)
    const first = await activateLicenseToken(tokenA, { ...opts() })
    const second = await activateLicenseToken(tokenB, { ...opts() })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.code).toBe("duplicate_license")
  })

  it("token ya activado en el historial (renovación antigua) → duplicate_license", async () => {
    const oldToken = makeLicenseToken(identity, key, { plan: "monthly", durationDays: 30, licenseId: "VLBA-abcdef000002" })
    // activar y luego REEMPLAZAR por otra más larga
    await activateLicenseToken(oldToken, { ...opts() })
    const renewal = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(renewal, { ...opts() })
    // intentar volver a activar la antigua → licenseId ya registrado
    const back = await activateLicenseToken(oldToken, { ...opts() })
    expect(back.ok).toBe(false)
    expect(back.code).toBe("duplicate_license")
  })
})

describe("13 · anti-downgrade (renovación)", () => {
  it("renovación MÁS CORTA que la activa → downgrade rechazado", async () => {
    const annual = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(annual, { ...opts() })

    const shorter = makeLicenseToken(identity, key, { plan: "monthly", durationDays: 30 })
    const res = await activateLicenseToken(shorter, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("downgrade")
    // la activa sigue siendo la anual
    const state = await getLicenseSystemState(opts())
    expect(state.license?.durationDays).toBe(365)
  })

  it("21 · renovación válida (vence después) → reemplaza a la activa", async () => {
    const annual = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(annual, { ...opts() })

    const renewal = makeLicenseToken(identity, key, { plan: "custom", durationDays: 730 })
    const res = await activateLicenseToken(renewal, { ...opts() })
    expect(res.ok).toBe(true)
    const state = await getLicenseSystemState(opts())
    expect(state.license?.durationDays).toBe(730)
    expect(store.history).toHaveLength(2)
    expect(store.history[0].current).toBe(true) // la más reciente
    expect(store.history[1].current).toBe(false)
  })

  it("renovación con el MISMO vencimiento → permitida (idempotente en tiempo)", async () => {
    const a = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(a, { ...opts() })
    const b = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(b, { ...opts() })
    expect(res.ok).toBe(true)
  })
})

describe("rechazos de activación", () => {
  it("14 · token vacío → empty_token", async () => {
    const res = await activateLicenseToken("", { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("empty_token")
    const spaces = await activateLicenseToken("   ", { ...opts() })
    expect(spaces.code).toBe("empty_token")
  })

  it("15 · token truncado → código estructural", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token.slice(0, token.length - 10), { ...opts() })
    expect(res.ok).toBe(false)
    expect(["bad_crc", "bad_frame", "too_short", "bad_charset"]).toContain(res.code)
  })

  it("16 · token excesivo → too_long", async () => {
    const res = await activateLicenseToken("VLBA2-" + "A".repeat(6000), { ...opts() })
    expect(res.ok).toBe(false)
    expect(["too_long", "bad_charset"]).toContain(res.code)
  })

  it("17 · token de versión futura → bad_version", async () => {
    const payload = makeTokenPayload(identity, { plan: "annual", durationDays: 365 })
    const token = buildLicenseToken(payload, key.privateKey)
    const decoded = decodeLicenseToken(token)
    const frame = buildTokenFrame(decoded.payloadBytes, decoded.signature)
    frame[3] = 0x07
    const future = formatWithDashes("VLBA2", base32Encode(frame))
    const res = await activateLicenseToken(future, { ...opts() })
    expect(res.code).toBe("bad_version")
  })

  it("9 · token de OTRO EQUIPO → binding_mismatch (mensaje humano, sin datos técnicos)", async () => {
    const otherIdentity = makeIdentity()
    const token = makeLicenseToken(otherIdentity, key, { plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("binding_mismatch")
    expect(res.reason).toContain("NO corresponde a este equipo")
    expect(store.record).toBeNull() // nada se persiste
  })

  it("10 · token de OTRO DISCO (mismo equipo) → binding_mismatch", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365, diskId: "DSK-AAAA-BBBB-CCCC" })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.code).toBe("binding_mismatch")
  })

  it("7 · firma de otra clave → bad_signature", async () => {
    const otherKey = generateLicenseKeyPair()
    const token = makeLicenseToken(identity, otherKey, { plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("bad_signature")
  })

  it("11 · licencia ya vencida → already_expired", async () => {
    const token = makeLicenseToken(identity, key, { startsAt: new Date(Date.now() - 400 * DAY_MS), plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("already_expired")
  })

  it("12 · licencia con inicio futuro → not_started", async () => {
    const token = makeLicenseToken(identity, key, { startsAt: new Date(Date.now() + 5 * DAY_MS), plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("not_started")
  })

  it("prefijo VLREQ2 (código de solicitud pegado como token) → bad_prefix", async () => {
    const res = await activateLicenseToken("VLREQ2-AbCdEfGhIjKl", { ...opts() })
    expect(res.code).toBe("bad_prefix")
  })

  it("token con bytes inválidos (charset) → bad_charset", async () => {
    const invalid = "VLBA2-" + "A".repeat(220) + "+" + "B".repeat(40)
    const res = await activateLicenseToken(invalid, { ...opts() })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("bad_charset")
  })
})

describe("27 · corrupción de DB", () => {
  it("licencia guardada corrupta (token inválido) → estado invalid graceful", async () => {
    const token = makeLicenseToken(identity, key, { plan: "annual", durationDays: 365 })
    await activateLicenseToken(token, { ...opts() })
    // "corrompen" la DB: el token guardado se reemplaza por basura
    const record = await store.getLicenseRecord()
    record!.token = "VLBA2-" + "Z".repeat(500)
    await store.saveLicenseRecord(record!)

    const state = await getLicenseSystemState(opts())
    expect(state.status).toBe("invalid")
    // el sistema sigue respondiendo (no lanza)
  })

  it("payloadJson corrupto en la DB → se trata como sin licencia", async () => {
    await store.saveLicenseRecord({
      token: "VLBA2-AAAA",
      payload: makeTokenPayload(identity, { plan: "annual", durationDays: 365 }),
      activatedAt: new Date().toISOString(),
      activatedBy: "test",
    })
    store.record!.payload = "no-es-json" as never
    const state = await getLicenseSystemState(opts())
    expect(["invalid", "unlicensed", "trial"]).toContain(state.status)
  })
})

describe("26 · reloj anti-rollback con licencia", () => {
  it("licencia vencida + reloj hacia atrás → sigue EXPIRED (no revive)", async () => {
    const past = Date.now() - 400 * DAY_MS
    const token = makeLicenseToken(identity, key, { startsAt: new Date(past), plan: "annual", durationDays: 365 })
    const res = await activateLicenseToken(token, { ...opts(), now: past + 10 * DAY_MS })
    expect(res.ok).toBe(true)

    const now = Date.now()
    const s1 = await getLicenseSystemState({ ...opts(), now })
    expect(s1.status).toBe("expired")

    // retroceden el reloj 200 días para "revivirla"
    const s2 = await getLicenseSystemState({ ...opts(), now: now - 200 * DAY_MS })
    expect(s2.clockTampered).toBe(true)
    expect(s2.status).toBe("expired")
  })
})

describe("código de solicitud desde la fachada (integración server-side)", () => {
  it("buildLicenseRequestCode usa la identidad dada y el código abre con la clave del emisor", async () => {
    const code = await buildLicenseRequestCode({
      customerName: "Lo D'Leo",
      identity,
      requestPublicKey: reqKey.publicKey,
    })
    const opened = openRequestCode(code, reqKey.privateKey, {})
    expect(opened.payload.customerName).toBe("Lo D'Leo")
    expect(opened.payload.installationId).toBe(identity.installationId)
    expect(opened.payload.diskId).toBe(identity.diskId)
  })

  it("customerName fuera de límites → error legible", async () => {
    expect(
      buildLicenseRequestCode({ customerName: "A", identity, requestPublicKey: reqKey.publicKey })
    ).rejects.toThrow(/nombre/i)
  })
})
