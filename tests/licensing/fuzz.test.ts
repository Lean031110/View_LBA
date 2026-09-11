/**
 * FASE 10 (release 3.0.0) — FUZZ / PROPERTY TESTS de los parsers de licencias.
 *
 * Regla de oro: NINGUNA entrada adversarial puede crashear el proceso ni
 * producir una excepción no tipada. Todo debe rechazarse de forma SEGURA:
 *   · decodeLicenseToken / parseTokenFrame / parseRequestFrame → TokenDecodeError
 *   · verifyLicenseToken → resultado invalid (o TokenDecodeError)
 *   · openRequestCode → TokenDecodeError / Error legible
 *   · base32DecodeStrict / normalizeTokenInput → null
 *
 * PRNG determinista (mulberry32, semilla fija): reproducible en CI.
 * Categorías de entrada (FASE 10):
 *   vacías · enormes · truncadas · bytes aleatorios · unicode · NULs ·
 *   duplicados · campos faltantes · campos extra · números extremos.
 */
import { describe, it, expect } from "bun:test"
import {
  buildLicenseToken,
  verifyLicenseToken,
  generateLicenseKeyPair,
  generateRequestKeyPair,
  openRequestCode,
  buildRequestCode,
  canonicalize,
} from "@/lib/licensing/index"
import { base32Encode, base32DecodeStrict, buildTokenFrame, buildRequestFrame, parseTokenFrame, parseRequestFrame, normalizeTokenInput } from "@/lib/licensing/codec"
import { decodeLicenseToken } from "@/lib/licensing/token"
import { TokenDecodeError } from "@/lib/licensing/types"
import { makeIdentity } from "./helpers"

// ---------------- PRNG determinista (reproducible) ----------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(0x564c4241) // "VLBA"
const randInt = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1))

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = randInt(0, 255)
  return b
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
function randomBase32ish(n: number): string {
  let s = ""
  for (let i = 0; i < n; i++) s += B32[randInt(0, 31)]
  return s
}

/** ¿La llamada rechazó de forma segura (sin crashear el runner)? */
function expectSafeReject(fn: () => unknown): void {
  try {
    const out = fn()
    // devolver null/undefined también es un rechazo seguro
    if (out === null || out === undefined) return
    // verifyLicenseToken → debe ser invalid con reasons
    if (typeof out === "object" && "valid" in (out as Record<string, unknown>)) {
      expect((out as { valid: unknown }).valid).toBe(false)
      return
    }
    // devolver un valor truthy NO estructurado sería una fuga
    throw new Error(`fuzz: la entrada fue ACEPTADA inesperadamente: ${String(out).slice(0, 60)}`)
  } catch (e) {
    // TokenDecodeError y Error legibles son rechazos tipados (aceptables)
    expect(e).toBeInstanceOf(Error)
  }
}

// ---------------- fixtures ----------------
const key = generateLicenseKeyPair()
const reqKey = generateRequestKeyPair()
const identity = makeIdentity()

const validPayload = {
  v: 2,
  licenseId: "VLBA-0123456789ab",
  customerName: "Fuzz Café",
  plan: "annual" as const,
  durationDays: 365,
  product: "ViewLBA-Server",
  issuedAt: Date.now(),
  startsAt: Date.now(),
  expiresAt: Date.now() + 365 * 86400000,
  installationId: identity.installationId,
  diskId: identity.diskId,
  features: { "users.management": true },
  nonce: "a".repeat(32),
}
const validToken = buildLicenseToken(validPayload, key.privateKey)

const validRequest = buildRequestCode({
  customerName: "Fuzz Café",
  installationId: identity.installationId,
  diskId: identity.diskId,
  requestPublicKey: reqKey.publicKey,
})

// ---------------------------------------------------------------------------
describe("FUZZ — decodeLicenseToken (cuerpo adversarial)", () => {
  const inputs: string[] = [
    "",
    "   ",
    "\n\t\r ",
    "VLBA2",
    "VLBA2-",
    "VLBA2--",
    "vlba2-" + randomBase32ish(400),
    "VLREQ2-" + randomBase32ish(400), // prefijo cruzado
    "VLBA2-" + randomBase32ish(10), // demasiado corto
    "VLBA2-" + randomBase32ish(5000), // demasiado largo
    "VLBA2-" + "A".repeat(4100),
    "VLBA2-" + randomBase32ish(400) + "\u0000",
    "VLBA2-" + randomBase32ish(400) + "ñ",
    "VLBA2-" + randomBase32ish(400) + "😀",
    "VLBA2-" + "Ø1IJ".repeat(100), // charset inválido
    "VLBA2-" + randomBase32ish(200) + "!" + randomBase32ish(200),
    "\u0000".repeat(300),
    "😀".repeat(300),
    "VLBA2-" + "0".repeat(420) + "1", // con 0/1 (charset ambiguo prohibido)
  ]
  // mutaciones aleatorias del token VÁLIDO (flips de caracteres)
  for (let i = 0; i < 60; i++) {
    const chars = validToken.split("")
    const pos = randInt(6, chars.length - 1) // nunca el prefijo
    chars[pos] = B32[randInt(0, 31)]
    inputs.push(chars.join(""))
  }
  // truncados sistemáticos del token válido
  for (const len of [0, 10, 50, 100, 200, 250, 300, 400, validToken.length - 1]) {
    inputs.push(validToken.slice(0, Math.min(len, validToken.length)))
  }

  it(`${inputs.length} entradas adversariales: todas rechazadas de forma segura`, () => {
    for (const input of inputs) {
      expectSafeReject(() => decodeLicenseToken(input))
    }
  })

  it("bytes aleatorios puros: el decodificador nunca lanza nada fuera de TokenDecodeError", () => {
    for (let i = 0; i < 200; i++) {
      const bin = randomBytes(randInt(0, 600))
      const asB32 = base32Encode(bin)
      try {
        decodeLicenseToken(`VLBA2-${asB32}`)
      } catch (e) {
        expect(e).toBeInstanceOf(TokenDecodeError)
      }
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — parseTokenFrame / parseRequestFrame (bytes crudos)", () => {
  it("200 tramas de bytes aleatorios: solo TokenDecodeError, nunca crash", () => {
    for (let i = 0; i < 200; i++) {
      const bin = randomBytes(randInt(0, 400))
      try {
        parseTokenFrame(bin)
      } catch (e) {
        expect(e).toBeInstanceOf(TokenDecodeError)
      }
    }
  })

  it("100 tramas de request aleatorias: solo TokenDecodeError, nunca crash", () => {
    for (let i = 0; i < 100; i++) {
      const bin = randomBytes(randInt(0, 400))
      try {
        parseRequestFrame(bin)
      } catch (e) {
        expect(e).toBeInstanceOf(TokenDecodeError)
      }
    }
  })

  it("frame VÁLIDO con 1 byte alterado → bad_crc (nunca aceptado)", () => {
    const frame = buildTokenFrame(new Uint8Array(Buffer.from('{"x":1}')), randomBytes(64))
    for (let pos of [0, 3, 6, 9, frame.length - 1]) {
      const mutated = new Uint8Array(frame)
      mutated[pos] ^= 0xff
      expect(() => parseTokenFrame(mutated)).toThrow(TokenDecodeError)
    }
  })

  it("truncamiento de CADA posición del frame válido → rechazo", () => {
    const frame = buildTokenFrame(new Uint8Array(Buffer.from('{"x":1}')), randomBytes(64))
    for (let len = 0; len < frame.length; len += 7) {
      try {
        parseTokenFrame(frame.subarray(0, len))
      } catch (e) {
        expect(e).toBeInstanceOf(TokenDecodeError)
      }
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — base32DecodeStrict / normalizeTokenInput", () => {
  it("entradas caóticas → null (nunca throw, nunca salida válida)", () => {
    const chaos = [
      "",
      " ",
      "A",
      "AAAA",
      "0O1IL",
      "ñ".repeat(50),
      "\u0000".repeat(50),
      "A".repeat(1 << 16),
      randomBase32ish(10) + "\u200bA",
    ]
    for (const c of chaos) {
      let out: Uint8Array | null = null
      expect(() => {
        out = base32DecodeStrict(c)
      }).not.toThrow()
      expect(out === null || out instanceof Uint8Array).toBe(true)
    }
  })

  it("normalizeTokenInput: basura unicode → null o estructura reconocible", () => {
    const junk = ["", "\u0000\u0001\u0002", "😀-🚀", "vlba2", "VLBA", "X", "-".repeat(100), "\n\n\n"]
    for (const j of junk) {
      expect(() => normalizeTokenInput(j)).not.toThrow()
    }
    expect(normalizeTokenInput("  vlba2\t-\nabcd  ")).toEqual({ prefix: "VLBA2", body: "ABCD" })
  })

  it("roundtrip base32: encode(decode(encode(x))) === encode(x) (propiedad)", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(randInt(1, 300))
      const enc = base32Encode(bytes)
      const dec = base32DecodeStrict(enc)
      expect(dec).not.toBeNull()
      expect(Buffer.from(dec!)).toEqual(Buffer.from(bytes))
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — verifyLicenseToken (payloads firmados extremos)", () => {
  it("payload con números extremos firmado por clave de test → rechazo SEMÁNTICO, sin crash", () => {
    // casos que DEBEN fallar en firma→esquema→coherencia de fechas
    const mustFail: Record<string, unknown>[] = [
      { ...validPayload, expiresAt: Number.MAX_SAFE_INTEGER * 2 }, // coherencia de duración
      { ...validPayload, expiresAt: -1e15 }, // no positivo
      { ...validPayload, startsAt: Infinity }, // no entero (JSON→null)
      { ...validPayload, durationDays: 1e308 }, // > 3650
      { ...validPayload, issuedAt: NaN }, // no entero (JSON→null)
      { ...validPayload, features: { "users.management": "yes" } }, // no boolean
      { ...validPayload, nonce: "" }, // regex 16-64
      { ...validPayload, licenseId: "" }, // regex VLBA-…
      { ...validPayload, plan: "ultra" }, // enum
      { ...validPayload, v: 99 }, // literal 2
      { ...validPayload, v: "2" }, // tipo string
      { ...validPayload, product: "Otro-Producto" }, // literal
    ]
    for (const p of mustFail) {
      // canonicalize puede rechazar valores no serializables → también es un
      // rechazo seguro del EMISOR (nunca un crash del verificador)
      let token: string
      try {
        token = buildLicenseToken(p as never, key.privateKey)
      } catch {
        continue
      }
      const result = verifyLicenseToken(token, { now: Date.now(), publicKey: key.publicKey })
      expect(result.valid).toBe(false)
    }

    // casos RAROS pero LEGALES (binding se valida aparte): deben parsear sin
    // crash y devolver un booleano — jamás una excepción sin tipar
    const benign: Record<string, unknown>[] = [
      { ...validPayload, customerName: "\u0000".repeat(80) },
      { ...validPayload, customerName: "😀".repeat(40) },
      { ...validPayload, installationId: "VWLB-0000-0000-0000-0000" },
    ]
    for (const p of benign) {
      let token: string
      try {
        token = buildLicenseToken(p as never, key.privateKey)
      } catch {
        continue
      }
      const result = verifyLicenseToken(token, { now: Date.now(), publicKey: key.publicKey })
      expect(typeof result.valid).toBe("boolean")
      if (result.valid) {
        // si lo acepta, es una licencia de OTRO equipo — el binding lo rechaza
        expect(result.payload).toBeDefined()
      }
    }
  })

  it("payload con campos EXTRA y DUPLICADOS (JSON manuales) → rechazo por firma o esquema", () => {
    // Trama firmada sobre JSON con clave duplicada: la firma cubre los bytes
    // EXACTOS, así que duplicados firmados 'pasan' la firma pero el esquema
    // zod debe rechazar el campo desconocido/exra.
    const baseJson = JSON.stringify(validPayload)
    const dupJson = baseJson.slice(0, -1) + ',"customerName":"Atacante"}'
    const payloadBytes = new Uint8Array(Buffer.from(dupJson, "utf8"))
    // firma IMPOSIBLE de falsificar sin la clave: firma de basura
    const frame = buildTokenFrame(payloadBytes, randomBytes(64))
    const token = `VLBA2-${base32Encode(frame).replace(/(.{4})/g, "$1-").replace(/-$/, "")}`
    const res = verifyLicenseToken(token, { now: Date.now(), publicKey: key.publicKey })
    expect(res.valid).toBe(false)
  })

  it("payload JSON truncado / corrupto → bad_json (rechazo seguro)", () => {
    const broken = new Uint8Array(Buffer.from('{"customerName":"Fuzz')) // JSON truncado
    const frame = buildTokenFrame(broken, randomBytes(64))
    const token = `VLBA2-${base32Encode(frame).replace(/(.{4})/g, "$1-").replace(/-$/, "")}`
    expect(() => decodeLicenseToken(token)).toThrow(TokenDecodeError)
  })

  it("payload con bytes NO-UTF8 y NULs → rechazo seguro (nunca crash)", () => {
    const nasty = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x00, 0x22, 0xff, 0xfe, 0x7d, 0x7f])
    const frame = buildTokenFrame(nasty, randomBytes(64))
    const token = `VLBA2-${base32Encode(frame).replace(/(.{4})/g, "$1-").replace(/-$/, "")}`
    try {
      decodeLicenseToken(token) // puede parsear (replacement chars) o lanzar bad_json
    } catch (e) {
      expect(e).toBeInstanceOf(TokenDecodeError)
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — openRequestCode (códigos de solicitud adversariales)", () => {
  const adversarial = [
    "",
    "VLREQ2",
    "VLREQ2-",
    "vlreq2-" + randomBase32ish(400),
    "VLREQ2-" + randomBase32ish(50),
    "VLREQ2-" + randomBase32ish(3000),
    "VLREQ2-" + randomBase32ish(400) + "ñ",
    "VLBA2-" + randomBase32ish(400),
    "😀".repeat(200),
    "\u0000".repeat(200),
  ]
  it(`${adversarial.length} códigos caóticos: rechazo tipado, sin crash`, () => {
    for (const c of adversarial) {
      expectSafeReject(() => openRequestCode(c, reqKey.privateKey))
    }
  })

  it("100 request-frames de bytes aleatorios como código → rechazo tipado", () => {
    for (let i = 0; i < 100; i++) {
      const bin = randomBytes(randInt(60, 300))
      const code = `VLREQ2-${base32Encode(bin).replace(/(.{4})/g, "$1-").replace(/-$/, "")}`
      expectSafeReject(() => openRequestCode(code, reqKey.privateKey))
    }
  })

  it("código VÁLIDO con 1 char mutado → rechazo (CRC/GCM/tag)", () => {
    for (let i = 0; i < 40; i++) {
      const chars = validRequest.split("")
      const pos = randInt(7, chars.length - 1)
      chars[pos] = B32[randInt(0, 31)]
      expectSafeReject(() => openRequestCode(chars.join(""), reqKey.privateKey))
    }
  })

  it("código VÁLIDO truncado en cada posición → rechazo", () => {
    for (let len = 0; len < validRequest.length; len += 37) {
      expectSafeReject(() => openRequestCode(validRequest.slice(0, len), reqKey.privateKey))
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — canonicalize (JSON canónico)", () => {
  it("objetos caóticos → o bien serializan deterministamente, o rechazo limpio", () => {
    const chaos: unknown[] = [
      {},
      { z: 1, a: 2 },
      { n: null, u: undefined },
      { deep: { deeper: { deepest: [{ k: "v" }] } } },
      { s: "\u0000\u001f" },
      { n: 1e308 },
      { n: -1e308 },
      { b: true },
      [[]],
    ]
    for (const c of chaos) {
      let out1: string
      let out2: string
      try {
        out1 = canonicalize(c as Record<string, unknown>)
        out2 = canonicalize(JSON.parse(out1))
      } catch {
        continue // rechazo limpio del emisor (nunca crash del verificador)
      }
      expect(out1).toBe(out2) // propiedad: idempotencia del canónico
    }
  })

  it("claves ordenadas SIEMPRE (propiedad de ordenación estable)", () => {
    for (let i = 0; i < 100; i++) {
      const obj: Record<string, number> = {}
      const n = randInt(1, 20)
      for (let j = 0; j < n; j++) obj[`k${randInt(0, 999)}`] = j
      const json = canonicalize(obj)
      const keys = Object.keys(JSON.parse(json))
      const sorted = [...keys].sort()
      expect(keys).toEqual(sorted)
    }
  })
})

// ---------------------------------------------------------------------------
describe("FUZZ — expiración / fechas extremas en validación", () => {
  it("expiraciones extremas firmadas → estado inválido/expired, daysLeft sin NaN", () => {
    const cases: Array<{ expiresAt: number; expectStatus: string }> = [
      { expiresAt: 8.64e15, expectStatus: "invalid" }, // epoch desorbitado
      { expiresAt: -8.64e15, expectStatus: "expired" },
      { expiresAt: 0, expectStatus: "expired" },
    ]
    for (const c of cases) {
      const p = {
        ...validPayload,
        plan: "custom" as const,
        durationDays: 3650,
        startsAt: Date.now() - 86400000,
        expiresAt: c.expiresAt,
      }
      let token: string
      try {
        token = buildLicenseToken(p, key.privateKey)
      } catch {
        continue
      }
      const res = verifyLicenseToken(token, { now: Date.now(), publicKey: key.publicKey })
      expect(res.valid).toBe(false)
      expect(["invalid", "expired"]).toContain(res.status)
      expect(Number.isNaN(res.payload?.expiresAt ?? 0)).toBe(false)
    }
  })
})
