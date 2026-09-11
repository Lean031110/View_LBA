/**
 * Tests: código de solicitud VLREQ2 (construcción + apertura).
 *
 * Cubre los casos 1-4 del requisito (solicitud válida / modificada /
 * expirada / replay) más tolerancia WhatsApp y límites.
 */
import { describe, expect, it } from "bun:test"
import { buildRequestCode, openRequestCode, normalizeRequestCode, REQUEST_CUSTOMER_NAME_MIN } from "@/lib/licensing/request-code"
import { generateRequestKeyPair } from "@/lib/licensing/crypto"
import { makeIdentity } from "./helpers"
import { REQUEST_CODE_MAX_AGE_DAYS } from "@/lib/licensing/types"
import { TokenDecodeError } from "@/lib/licensing/types"

const identity = makeIdentity()
const reqKey = generateRequestKeyPair()
const DAY = 24 * 60 * 60 * 1000

describe("1 · solicitud válida", () => {
  it("construye VLREQ2-… con el prefijo y el formato agrupado correcto", () => {
    const code = buildRequestCode({
      customerName: "Lo D'Leo",
      installationId: identity.installationId,
      diskId: identity.diskId,
      requestPublicKey: reqKey.publicKey,
    })
    expect(code.startsWith("VLREQ2-")).toBe(true)
    // grupos de 4 tras el prefijo
    const groups = code.slice("VLREQ2-".length).split("-")
    for (const g of groups.slice(0, -1)) expect(g.length).toBe(4)
    expect(groups[groups.length - 1].length).toBeLessThanOrEqual(4)
  })

  it("roundtrip: abrir con la clave privada del emisor recupera EXACTAMENTE el payload", () => {
    const now = Date.now()
    const code = buildRequestCode({
      customerName: "Lo D'Leo",
      installationId: identity.installationId,
      diskId: identity.diskId,
      now,
      requestPublicKey: reqKey.publicKey,
    })
    const opened = openRequestCode(code, reqKey.privateKey, { now })
    expect(opened.payload.customerName).toBe("Lo D'Leo")
    expect(opened.payload.installationId).toBe(identity.installationId)
    expect(opened.payload.diskId).toBe(identity.diskId)
    expect(opened.payload.product).toBe("ViewLBA-Server")
    expect(opened.payload.v).toBe(2)
    expect(opened.payload.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(opened.payload.requestedAt).toBe(now)
  })

  it("el customerName y Disk ID viajan CIFRADOS (no aparecen en claro en el código)", () => {
    const code = buildRequestCode({
      customerName: "NegocioMuySecreto123",
      installationId: identity.installationId,
      diskId: identity.diskId,
      requestPublicKey: reqKey.publicKey,
    })
    expect(code).not.toContain("NegocioMuySecreto123")
    expect(code).not.toContain(identity.installationId)
    expect(code).not.toContain(identity.diskId)
  })

  it("dos códigos del mismo payload llevan nonces distintos (efímero)", () => {
    const a = buildRequestCode({ customerName: "XX", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const b = buildRequestCode({ customerName: "XX", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    expect(a).not.toBe(b)
  })

  it("abrir con la clave privada CORRECTA de otro par → rechazo (emisor incorrecto)", () => {
    const code = buildRequestCode({ customerName: "XX", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const other = generateRequestKeyPair()
    try {
      openRequestCode(code, other.privateKey, {})
      expect.unreachable()
    } catch (e) {
      // ECDH con clave ajena → GCM tag no verifica → "no se puede abrir"
      expect((e as Error).message).toMatch(/no se puede abrir|alterado/i)
    }
  })

  it("valida el customerName (2..100)", () => {
    expect(() =>
      buildRequestCode({ customerName: "A", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    ).toThrow()
    expect(() =>
      buildRequestCode({ customerName: "x".repeat(101), installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    ).toThrow()
    expect(REQUEST_CUSTOMER_NAME_MIN).toBe(2)
  })
})

describe("2 · solicitud modificada (anti-tampering)", () => {
  const build = () =>
    buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })

  it("1 carácter del cuerpo alterado → charset o CRC falla", () => {
    const code = build()
    // cambiar el último char del cuerpo base64url por otro válido del alfabeto
    const pos = code.length - 1
    const flipped = code.slice(0, pos) + (code[pos] === "A" ? "B" : "A")
    try {
      openRequestCode(flipped, reqKey.privateKey, {})
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(TokenDecodeError)
      expect(["bad_crc", "bad_frame", "bad_charset", "bad_prefix"]).toContain((e as TokenDecodeError).code)
    }
  })

  it("caracteres inválidos inyectados → bad_charset", () => {
    const code = build()
    const withPlus = code.slice(0, -2) + "+A"
    try {
      openRequestCode(withPlus, reqKey.privateKey, {})
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_charset")
    }
  })

  it("prefijo VLBA2 (token) usado como código → bad_prefix", () => {
    try {
      openRequestCode("VLBA2-AbCdEfGh", reqKey.privateKey, {})
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_prefix")
    }
  })
})

describe("3 · solicitud expirada", () => {
  it("requestedAt hace más de 15 días → rechazo con mensaje de expiración", () => {
    const now = Date.now()
    const old = buildRequestCode({
      customerName: "Lo D'Leo",
      installationId: identity.installationId,
      diskId: identity.diskId,
      now: now - (REQUEST_CODE_MAX_AGE_DAYS + 1) * DAY,
      requestPublicKey: reqKey.publicKey,
    })
    try {
      openRequestCode(old, reqKey.privateKey, { now })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/expiró/i)
    }
  })

  it("requestedAt dentro de la ventana → OK (día 14)", () => {
    const now = Date.now()
    const code = buildRequestCode({
      customerName: "Lo D'Leo",
      installationId: identity.installationId,
      diskId: identity.diskId,
      now: now - 14 * DAY,
      requestPublicKey: reqKey.publicKey,
    })
    const opened = openRequestCode(code, reqKey.privateKey, { now })
    expect(opened.payload.customerName).toBe("Lo D'Leo")
  })

  it("requestedAt futura (reloj del cliente incorrecto) → rechazo", () => {
    const now = Date.now()
    const future = buildRequestCode({
      customerName: "Lo D'Leo",
      installationId: identity.installationId,
      diskId: identity.diskId,
      now: now + 5 * DAY,
      requestPublicKey: reqKey.publicKey,
    })
    try {
      openRequestCode(future, reqKey.privateKey, { now })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/futura/i)
    }
  })
})

describe("4 · anti-replay (hash del código)", () => {
  it("el MISMO código produce SIEMPRE el mismo hash (registro del emisor)", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const a = openRequestCode(code, reqKey.privateKey, {})
    const b = openRequestCode(code, reqKey.privateKey, {})
    expect(a.requestHash).toBe(b.requestHash)
    expect(a.requestHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("códigos DISTINTOS (nonces distintos) → hashes distintos", () => {
    const a = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const b = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const ha = openRequestCode(a, reqKey.privateKey, {}).requestHash
    const hb = openRequestCode(b, reqKey.privateKey, {}).requestHash
    expect(ha).not.toBe(hb)
  })

  it("el hash es estable ante la normalización (guiones/espacios irrelevantes)", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    // re-agrupar los guiones desde cero (distinta agrupación, mismo valor)
    const compact = code.replace(/-/g, "")
    const messy = compact.slice(0, 6) + "-" + compact.slice(6).replace(/(.{5})/g, "$1-").replace(/-$/, "")
    const a = openRequestCode(code, reqKey.privateKey, {})
    const b = openRequestCode("  " + messy + "\n", reqKey.privateKey, {})
    expect(b.requestHash).toBe(a.requestHash)
  })
})

describe("tolerancia WhatsApp (normalización de entrada)", () => {
  it("código pegado con saltos de línea y espacios → abre correctamente", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const wrapped = (code.match(/.{1,24}/g) ?? []).join("\n")
    const opened = openRequestCode(wrapped, reqKey.privateKey, {})
    expect(opened.payload.customerName).toBe("Lo D'Leo")
  })

  it("prefijo en minúsculas → aceptado", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const lowered = "vlreq2" + code.slice(7)
    const opened = openRequestCode(lowered, reqKey.privateKey, {})
    expect(opened.payload.customerName).toBe("Lo D'Leo")
  })

  it("código TRUNCADO → too_short", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    const truncated = code.slice(0, 80)
    try {
      openRequestCode(truncated, reqKey.privateKey, {})
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("too_short")
    }
  })

  it("código EXCESIVO (> 2048 normalizado) → too_long", () => {
    const code = buildRequestCode({ customerName: "Lo D'Leo", installationId: identity.installationId, diskId: identity.diskId, requestPublicKey: reqKey.publicKey })
    // guiones/spacios no cuentan tras la normalización: relleno con chars válidos
    const huge = code + "A".repeat(2100)
    try {
      openRequestCode(huge, reqKey.privateKey, {})
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("too_long")
    }
  })

  it("normalizeRequestCode devuelve el código compacto (mayúsculas) o null", () => {
    expect(normalizeRequestCode(" vlreq2-AbCd \n")).toBe("VLREQ2ABCD")
    expect(normalizeRequestCode("otra-cosa")).toBeNull()
  })
})
