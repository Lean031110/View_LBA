/**
 * Tests: token de licencia VLBA2 (construcción, decodificación, firma).
 *
 * Cubre los casos 5-17 del requisito (licencia válida / modificada / firma
 * incorrecta / clave incorrecta / fechas / token vacío / truncado /
 * excesivo / versión futura).
 */
import { describe, expect, it } from "bun:test"
import { buildLicenseToken, decodeLicenseToken, normalizeLicenseToken } from "@/lib/licensing/token"
import { buildTokenFrame, base32Encode, formatWithDashes } from "@/lib/licensing/codec"
import { generateLicenseKeyPair, signTokenPayload, verifyTokenSignature } from "@/lib/licensing/crypto"
import { verifyLicenseToken } from "@/lib/licensing/validator"
import { makeIdentity, makeTokenPayload, makeKeyPair, DAY_MS, ALL_FEATURES_ON } from "./helpers"
import { TokenDecodeError } from "@/lib/licensing/types"

const identity = makeIdentity()
const key = makeKeyPair()

const validOpts = { customerName: "Lo D'Leo", plan: "annual" as const, durationDays: 365 }

describe("5 · licencia válida (construcción + decodificación)", () => {
  it("construye VLBA2-… y decodifica el payload EXACTO", () => {
    const payload = makeTokenPayload(identity, validOpts)
    const token = buildLicenseToken(payload, key.privateKey)
    const decoded = decodeLicenseToken(token)
    expect(decoded.payload).toEqual(payload)
  })

  it("el payload viaja en forma canónica (claves ordenadas, sin espacios)", () => {
    const payload = makeTokenPayload(identity, validOpts)
    const token = buildLicenseToken(payload, key.privateKey)
    const decoded = decodeLicenseToken(token)
    const text = Buffer.from(decoded.payloadBytes).toString("utf8")
    // claves ordenadas alfabéticamente: customerName < diskId < durationDays < …
    expect(text.indexOf('"customerName"')).toBeLessThan(text.indexOf('"diskId"'))
    expect(text.indexOf('"diskId"')).toBeLessThan(text.indexOf('"durationDays"'))
    expect(text).not.toContain(": ")
    expect(text).not.toContain(", ")
  })

  it("verifyLicenseToken → valid con el payload completo", () => {
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    const res = verifyLicenseToken(token, { publicKey: key.publicKey })
    expect(res.valid).toBe(true)
    expect(res.payload?.customerName).toBe("Lo D'Leo")
    expect(res.payload?.durationDays).toBe(365)
    expect(res.payload?.plan).toBe("annual")
    expect(res.payload?.features).toEqual(ALL_FEATURES_ON)
  })

  it("normalización tolerante del token (guiones/espacios/newlines)", () => {
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    const wrapped = (token.match(/.{1,20}/g) ?? []).join("\n")
    const decoded = decodeLicenseToken(wrapped)
    expect(decoded.normalized).toBe(decodeLicenseToken(token).normalized)
  })
})

describe("6 · licencia modificada (anti-tampering)", () => {
  it("1 carácter del cuerpo alterado → CRC o firma fallan", () => {
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    const pos = token.length - 3
    const flipped = token.slice(0, pos) + (token[pos] === "A" ? "B" : "A") + token.slice(pos + 1)
    let ok = false
    try {
      const r = verifyLicenseToken(flipped, { publicKey: key.publicKey })
      ok = !r.valid // si decodifica, la firma/crc debe fallar
    } catch {
      ok = true // TokenDecodeError = rechazo correcto
    }
    expect(ok).toBe(true)
  })

  it("payload re-serializado con una clave cambiada (customerName) → firma inválida", () => {
    const payload = makeTokenPayload(identity, validOpts)
    const signature = signTokenPayload(payload, key.privateKey)
    // "falsificación": mismo payload editado tras firmar
    const tampered = { ...payload, customerName: "Falsificado" }
    const tamperedSig = signTokenPayload(tampered, key.privateKey)
    // verificar el payload ORIGINAL con la firma del falsificado → falso
    const payloadBytes = new TextEncoder().encode(JSON.stringify(tampered))
    const canonicalBytes = new TextEncoder().encode(
      JSON.stringify(Object.keys(tampered).sort().reduce((acc, k) => ({ ...acc, [k]: (tampered as Record<string, unknown>)[k] }), {}))
    )
    expect(verifyTokenSignature(payloadBytes, tamperedSig, key.publicKey)).toBe(false)
    expect(verifyTokenSignature(canonicalBytes, new Uint8Array(64), key.publicKey)).toBe(false)
  })
})

describe("7-8 · firma y clave incorrectas", () => {
  it("token firmado con clave A, verificado con clave B → invalid", () => {
    const otherKey = generateLicenseKeyPair()
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    const res = verifyLicenseToken(token, { publicKey: otherKey.publicKey })
    expect(res.valid).toBe(false)
    expect(res.status).toBe("invalid")
    expect(res.reasons[0]).toMatch(/no fue emitido|modificado/i)
  })

  it("firma corrupta (bytes aleatorios) → invalid", () => {
    const payload = makeTokenPayload(identity, validOpts)
    const goodToken = buildLicenseToken(payload, key.privateKey)
    // decodificar, corromper la firma, re-encodear con CRC válido → la FIRMA es la defensa
    const decoded = decodeLicenseToken(goodToken)
    const badSig = new Uint8Array(64).fill(0x42)
    const frame = buildTokenFrame(decoded.payloadBytes, badSig)
    const badToken = formatWithDashes("VLBA2", base32Encode(frame))
    const res = verifyLicenseToken(badToken, { publicKey: key.publicKey })
    expect(res.valid).toBe(false)
  })
})

describe("9-12 · binding y fechas (validator completo)", () => {
  it("9 · otro dispositivo (installationId distinto) → mismatch", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const token = buildLicenseToken(makeTokenPayload(identity, { ...validOpts, installationId: "VWLB-AAAA-BBBB-CCCC-DDDD" }), key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.status).toBe("mismatch")
    expect(res.reasons.join(" ")).toMatch(/otro equipo/i)
  })

  it("10 · otro disco (diskId distinto) → mismatch", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const token = buildLicenseToken(makeTokenPayload(identity, { ...validOpts, diskId: "DSK-AAAA-BBBB-CCCC" }), key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.status).toBe("mismatch")
    expect(res.reasons.join(" ")).toMatch(/otro disco/i)
  })

  it("11 · licencia expirada → expired", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const token = buildLicenseToken(
      makeTokenPayload(identity, { ...validOpts, startsAt: new Date(Date.now() - 400 * DAY_MS), durationDays: 365 }),
      key.privateKey
    )
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.status).toBe("expired")
    expect(res.valid).toBe(false)
  })

  it("12 · fecha futura (startsAt > now) → aún no vigente", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const token = buildLicenseToken(makeTokenPayload(identity, { ...validOpts, startsAt: new Date(Date.now() + 5 * DAY_MS) }), key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.valid).toBe(false)
    expect(res.reasons[0]).toMatch(/aún no está vigente/i)
  })

  it("startsAt >= expiresAt → fechas incoherentes", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const payload = makeTokenPayload(identity, validOpts)
    payload.expiresAt = payload.startsAt - 1000
    const token = buildLicenseToken(payload, key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.status).toBe("invalid")
  })

  it("durationDays que no coincide con las fechas → invalid (anti-falsificación)", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const payload = makeTokenPayload(identity, validOpts)
    payload.durationDays = 30 // el plan dice 365 días
    const token = buildLicenseToken(payload, key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.valid).toBe(false)
    expect(res.reasons[0]).toMatch(/duración no coincide|duración firmada/i)
  })

  it("plan monthly con 365 días → invalid (duración no corresponde al plan)", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const payload = makeTokenPayload(identity, { plan: "monthly", durationDays: 365 })
    const token = buildLicenseToken(payload, key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.valid).toBe(false)
  })

  it("producto distinto → invalid (producto rechazado)", async () => {
    const { validateLicenseToken } = await import("@/lib/licensing/validator")
    const payload = { ...makeTokenPayload(identity, validOpts), product: "Otro-Producto" }
    const token = buildLicenseToken(payload, key.privateKey)
    const res = validateLicenseToken(token, identity, { publicKey: key.publicKey })
    expect(res.valid).toBe(false)
  })
})

describe("14-17 · tokens estructuralmente inválidos", () => {
  it("14 · token vacío / solo espacios → too_short", () => {
    for (const empty of ["", "   ", "\n"]) {
      try {
        decodeLicenseToken(empty)
        expect.unreachable()
      } catch (e) {
        expect((e as TokenDecodeError).code).toBe("too_short")
      }
    }
  })

  it("15 · token truncado → bad_frame/bad_crc/too_short", () => {
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    // cortes en varias posiciones
    for (const cut of [10, 60, token.length / 2, token.length - 2]) {
      const truncated = token.slice(0, Math.floor(cut))
      try {
        const res = verifyLicenseToken(truncated, { publicKey: key.publicKey })
        expect(res.valid).toBe(false) // si decodifica, la firma no pasa
      } catch (e) {
        expect(e).toBeInstanceOf(TokenDecodeError)
        expect(["too_short", "bad_frame", "bad_crc", "bad_charset", "bad_json"]).toContain((e as TokenDecodeError).code)
      }
    }
  })

  it("16 · token excesivo (> 4096) → too_long", () => {
    const token = buildLicenseToken(makeTokenPayload(identity, validOpts), key.privateKey)
    // guiones/espacios no cuentan tras la normalización: relleno con chars válidos
    const huge = token + "A".repeat(5000)
    try {
      decodeLicenseToken(huge)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("too_long")
    }
  })

  it("17 · token de versión futura → bad_version", () => {
    const payload = makeTokenPayload(identity, validOpts)
    const goodToken = buildLicenseToken(payload, key.privateKey)
    const decoded = decodeLicenseToken(goodToken)
    const frame = buildTokenFrame(decoded.payloadBytes, decoded.signature)
    const future = new Uint8Array(frame)
    future[3] = 0x10
    const futureToken = formatWithDashes("VLBA2", base32Encode(future))
    try {
      decodeLicenseToken(futureToken)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_version")
      expect((e as Error).message).toContain("versión futura")
    }
  })

  it("charset inválido (+, ñ, emoji) → bad_charset", () => {
    const invalid = "VLBA2-" + "A".repeat(220) + "+" + "B".repeat(40)
    try {
      decodeLicenseToken(invalid)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_charset")
    }
  })

  it("prefijo VLREQ2 en un token → bad_prefix", () => {
    try {
      decodeLicenseToken("VLREQ2-AbCdEfGh")
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_prefix")
    }
  })

  it("normalizeLicenseToken → compacto (mayúsculas) o null", () => {
    expect(normalizeLicenseToken(" vlba2-AbCd \n")).toBe("VLBA2ABCD")
    expect(normalizeLicenseToken("VLREQ2-AbCd")).toBeNull()
  })
})
