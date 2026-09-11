/**
 * Tests: códec de tokens VLBA2 / códigos VLREQ2.
 *
 * Cubre: CRC32, base64url estricto, formato con guiones + normalización
 * tolerante (WhatsApp), tramas binarias (roundtrip, truncado, alterado,
 * versión futura, longitudes).
 */
import { describe, expect, it } from "bun:test"
import { crc32, base32Encode, base32DecodeStrict, formatWithDashes, normalizeTokenInput, buildTokenFrame, parseTokenFrame, buildRequestFrame, parseRequestFrame } from "@/lib/licensing/codec"
import { TokenDecodeError } from "@/lib/licensing/types"

describe("crc32", () => {
  it("CRC32 IEEE de vectores conocidos", () => {
    expect(crc32(new Uint8Array([]))).toBe(0)
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926) // vector clásico
    expect(crc32(new TextEncoder().encode("ViewLBA"))).not.toBe(0)
  })

  it("es determinista y sensible a 1 byte", () => {
    const a = new TextEncoder().encode("ViewLBA-licencia")
    const b = new TextEncoder().encode("ViewLBA-licenciA")
    expect(crc32(a)).not.toBe(crc32(b))
  })
})

describe("base32 (RFC 4648, sin padding)", () => {
  it("roundtrip sin padding y alfabeto A-Z2-7", () => {
    const data = new Uint8Array(256).map((_, i) => i)
    const enc = base32Encode(data)
    expect(enc).toMatch(/^[A-Z2-7]+$/)
    expect(base32DecodeStrict(enc)).toEqual(data)
  })

  it("RECHAZA caracteres fuera del alfabeto (+, /, =, 0, 1, 8, 9, ñ, emoji)", () => {
    expect(base32DecodeStrict("ABC+DEF")).toBeNull()
    expect(base32DecodeStrict("ABC/DEF")).toBeNull()
    expect(base32DecodeStrict("ABC=DEF")).toBeNull()
    expect(base32DecodeStrict("0123456")).toBeNull() // dígitos 0/1/8/9 no existen en base32
    expect(base32DecodeStrict("ABC DEF")).toBeNull()
    expect(base32DecodeStrict("AÑBCD")).toBeNull()
    expect(base32DecodeStrict("ABCD✨")).toBeNull()
  })

  it("RECHAZA longitudes imposibles (mod 8 ∈ {1,3,6})", () => {
    expect(base32DecodeStrict("A")).toBeNull()
    expect(base32DecodeStrict("AAA")).toBeNull()
    expect(base32DecodeStrict("ABCDEF")).toBeNull()
  })

  it("RECHAZA bits basura al final (alterado/truncado)", () => {
    // 'A'=0 … grupo válido de 2 chars "AA" (1 byte); "AB" tiene bits no nulos
    expect(base32DecodeStrict("AB")).toBeNull()
  })

  it("vector conocido: 'foobar' RFC 4648", () => {
    // test vector clásico de RFC 4648 (sin padding)
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI======".replace(/=/g, ""))
    expect(base32DecodeStrict("MZXW6YTBOI")).toEqual(new TextEncoder().encode("foobar"))
  })
})

describe("formato externo con guiones (WhatsApp-friendly)", () => {
  it("formatWithDashes agrupa de a 4 con prefijo", () => {
    const out = formatWithDashes("VLBA2", "A2CDEFGHIJKL")
    expect(out).toBe("VLBA2-A2CD-EFGH-IJKL")
  })

  it("normaliza espacios, saltos de línea, tabuladores y guiones (incl. em-dash)", () => {
    const messy = "vlba2-a2cd\r\n EFGH-\u2013IJKL\u200b"
    const n = normalizeTokenInput(messy)
    expect(n).not.toBeNull()
    expect(n!.prefix).toBe("VLBA2")
    expect(n!.body).toBe("A2CDEFGHIJKL")
  })

  it("entrada case-insensitive: minúsculas → mayúsculas (alfabeto base32 sin ambigüedad)", () => {
    expect(normalizeTokenInput("vlba2-a2cd")?.body).toBe("A2CD")
    expect(normalizeTokenInput("VLBA2-a2cd")?.body).toBe("A2CD")
    expect(normalizeTokenInput("vlba2-A2CD")?.body).toBe("A2CD")
  })

  it("rechaza prefijos desconocidos y cuerpos vacíos", () => {
    expect(normalizeTokenInput("XXXX2-A2CD")).toBeNull()
    expect(normalizeTokenInput("")).toBeNull()
    expect(normalizeTokenInput("VLBA2-")).toBeNull()
  })
})

describe("trama del token VLBA2", () => {
  const payload = new TextEncoder().encode('{"v":2,"licenseId":"VLBA-abcdef012345"}')
  const sig = new Uint8Array(64).map((_, i) => i)

  it("roundtrip build/parse exacto", () => {
    const frame = buildTokenFrame(payload, sig)
    const parsed = parseTokenFrame(frame)
    expect([...parsed.payloadBytes]).toEqual([...payload])
    expect([...parsed.signature]).toEqual([...sig])
  })

  it("token truncado (se corta 1 byte) → bad_frame", () => {
    const frame = buildTokenFrame(payload, sig)
    const truncated = frame.subarray(0, frame.length - 1)
    expect(() => parseTokenFrame(truncated)).toThrow(TokenDecodeError)
  })

  it("token alterado (1 byte del payload) → bad_crc", () => {
    const frame = buildTokenFrame(payload, sig)
    const tampered = new Uint8Array(frame)
    tampered[10] ^= 0x01
    let threw = false
    try {
      parseTokenFrame(tampered)
    } catch (e) {
      threw = true
      expect((e as TokenDecodeError).code).toBe("bad_crc")
    }
    expect(threw).toBe(true)
  })

  it("token de versión FUTURA (0x03) → bad_version explícito", () => {
    const frame = buildTokenFrame(payload, sig)
    const future = new Uint8Array(frame)
    future[3] = 0x03
    try {
      parseTokenFrame(future)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_version")
      expect((e as Error).message).toContain("versión futura")
    }
  })

  it("magic incorrecto → bad_frame", () => {
    const frame = buildTokenFrame(payload, sig)
    const wrong = new Uint8Array(frame)
    wrong[0] = 0x00
    expect(() => parseTokenFrame(wrong)).toThrow(TokenDecodeError)
  })

  it("longitud inconsistente (payloadLen ≠ real) → bad_frame", () => {
    const frame = buildTokenFrame(payload, sig)
    const view = Buffer.from(frame)
    view.writeUInt16BE(payload.length - 1, 4) // declara menos de lo que hay + recalcula? NO: sin recalcular CRC
    // sin CRC válido la trama falla primero por longitud
    try {
      parseTokenFrame(new Uint8Array(view))
      expect.unreachable()
    } catch (e) {
      expect(["bad_frame", "bad_crc"]).toContain((e as TokenDecodeError).code)
    }
  })
})

describe("trama del código VLREQ2", () => {
  const eph = new Uint8Array(32).map((_, i) => i)
  const iv = new Uint8Array(12).fill(0xab)
  const ct = new Uint8Array(64).fill(0xcd)

  it("roundtrip build/parse exacto", () => {
    const frame = buildRequestFrame(eph, iv, ct)
    const parsed = parseRequestFrame(frame)
    expect([...parsed.ephemeralPub]).toEqual([...eph])
    expect([...parsed.iv]).toEqual([...iv])
    expect([...parsed.ciphertext]).toEqual([...ct])
  })

  it("código alterado (1 byte) → bad_crc", () => {
    const frame = buildRequestFrame(eph, iv, ct)
    const tampered = new Uint8Array(frame)
    tampered[40] ^= 0xff
    try {
      parseRequestFrame(tampered)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_crc")
    }
  })

  it("código truncado → bad_frame", () => {
    const frame = buildRequestFrame(eph, iv, ct)
    expect(() => parseRequestFrame(frame.subarray(0, frame.length - 3))).toThrow(TokenDecodeError)
  })

  it("versión futura → bad_version", () => {
    const frame = buildRequestFrame(eph, iv, ct)
    const future = new Uint8Array(frame)
    future[3] = 0x09
    try {
      parseRequestFrame(future)
      expect.unreachable()
    } catch (e) {
      expect((e as TokenDecodeError).code).toBe("bad_version")
    }
  })
})
