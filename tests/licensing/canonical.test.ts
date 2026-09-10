/**
 * Tests: canonicalización de payloads de licencia (sección 27).
 * La firma depende de que el canónico sea DETERMINISTA e independiente del
 * orden de claves del JSON original.
 */
import { describe, expect, it } from "bun:test"
import { canonicalizeLicensePayload, stripSignature } from "@/lib/licensing/canonical"

describe("canonicalizeLicensePayload", () => {
  it("es determinista: mismo objeto → mismo string", () => {
    const payload = { b: 1, a: "x", c: { z: true, y: [1, 2] } }
    expect(canonicalizeLicensePayload(payload)).toBe(canonicalizeLicensePayload({ ...payload }))
  })

  it("es INDEPENDIENTE del orden de claves (misma firma aunque el JSON se re-serialice)", () => {
    const a = { schemaVersion: 1, customerName: "Leandro", plan: "annual", features: { b: true, a: false } }
    const b = { plan: "annual", features: { a: false, b: true }, customerName: "Leandro", schemaVersion: 1 }
    expect(canonicalizeLicensePayload(a)).toBe(canonicalizeLicensePayload(b))
  })

  it("ordena claves recursivamente (anidado profundo)", () => {
    const canonical = canonicalizeLicensePayload({ z: 1, a: { y: { c: 3, b: 2, a: 1 } } })
    expect(canonical).toBe('{"a":{"y":{"a":1,"b":2,"c":3}},"z":1}')
  })

  it("conserva el ORDEN de los arrays (posición significativa)", () => {
    expect(canonicalizeLicensePayload({ list: [3, 1, 2] })).not.toBe(canonicalizeLicensePayload({ list: [1, 2, 3] }))
    expect(canonicalizeLicensePayload({ list: ["a", "b"] })).toBe('{"list":["a","b"]}')
  })

  it("no añade espacios (bytes firmables exactos)", () => {
    expect(canonicalizeLicensePayload({ a: "hola" })).toBe('{"a":"hola"}')
  })

  it("conserva tipos primitivos sin coerción (números/booleans/null)", () => {
    expect(canonicalizeLicensePayload({ n: 1, b: false, x: null })).toBe('{"b":false,"n":1,"x":null}')
  })

  it("un payload real de licencia produce el mismo canónico con claves barajadas", () => {
    const license = {
      schemaVersion: 1,
      licenseId: "VLBA-aaaaaaaaaaaa",
      customerName: "Leandro Bueno",
      plan: "monthly",
      issuedAt: "2026-09-10T00:00:00.000Z",
      startsAt: "2026-09-10T00:00:00.000Z",
      expiresAt: "2026-10-10T00:00:00.000Z",
      deviceId: "VWLB-0094-6114-A3A4-8905",
      diskId: "DSK-A5ED-432A-37DD",
      installPath: "c:/pantallarestaurante",
      product: "ViewLBA-Server",
      features: { "users.management": true },
    }
    const shuffled = {
      features: { "users.management": true },
      product: "ViewLBA-Server",
      installPath: "c:/pantallarestaurante",
      diskId: "DSK-A5ED-432A-37DD",
      deviceId: "VWLB-0094-6114-A3A4-8905",
      expiresAt: "2026-10-10T00:00:00.000Z",
      startsAt: "2026-09-10T00:00:00.000Z",
      issuedAt: "2026-09-10T00:00:00.000Z",
      plan: "monthly",
      customerName: "Leandro Bueno",
      licenseId: "VLBA-aaaaaaaaaaaa",
      schemaVersion: 1,
    }
    expect(canonicalizeLicensePayload(license)).toBe(canonicalizeLicensePayload(shuffled))
  })
})

describe("stripSignature", () => {
  it("elimina SOLO signature (el resto intacto)", () => {
    const obj = { a: 1, signature: "sig", deviceId: "x" }
    expect(stripSignature(obj)).toEqual({ a: 1, deviceId: "x" })
  })

  it("objeto sin signature queda igual", () => {
    expect(stripSignature({ a: 1 })).toEqual({ a: 1 })
  })
})
