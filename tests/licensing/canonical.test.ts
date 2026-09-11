/**
 * Tests: canonicalización de payloads (tokens VLBA2 + solicitudes VLREQ2).
 * La firma depende de que el canónico sea DETERMINISTA e independiente del
 * orden de claves del JSON original.
 */
import { describe, expect, it } from "bun:test"
import { canonicalize, sortKeysDeep } from "@/lib/licensing/canonical"

describe("canonicalize", () => {
  it("es determinista: mismo objeto → mismo string", () => {
    const payload = { b: 1, a: "x", c: { z: true, y: [1, 2] } }
    expect(canonicalize(payload)).toBe(canonicalize({ ...payload }))
  })

  it("es INDEPENDIENTE del orden de claves (misma firma aunque el JSON se re-serialice)", () => {
    const a = { v: 2, customerName: "Leandro", plan: "annual", features: { b: true, a: false } }
    const b = { plan: "annual", features: { a: false, b: true }, customerName: "Leandro", v: 2 }
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it("ordena claves recursivamente (anidado profundo)", () => {
    expect(canonicalize({ z: 1, a: { y: { c: 3, b: 2, a: 1 } } })).toBe('{"a":{"y":{"a":1,"b":2,"c":3}},"z":1}')
  })

  it("conserva el ORDEN de los arrays (posición significativa)", () => {
    expect(canonicalize({ list: [3, 1, 2] })).not.toBe(canonicalize({ list: [1, 2, 3] }))
    expect(canonicalize({ list: ["a", "b"] })).toBe('{"list":["a","b"]}')
  })

  it("no añade espacios (bytes firmables exactos)", () => {
    expect(canonicalize({ a: "hola" })).toBe('{"a":"hola"}')
  })

  it("conserva tipos primitivos sin coerción (números/booleans/null)", () => {
    expect(canonicalize({ n: 1, b: false, x: null })).toBe('{"b":false,"n":1,"x":null}')
  })

  it("un payload real de token v2 produce el mismo canónico con claves barajadas", () => {
    const token = {
      v: 2,
      licenseId: "VLBA-aaaaaaaaaaaa",
      customerName: "Lo D'Leo",
      plan: "monthly",
      durationDays: 30,
      product: "ViewLBA-Server",
      issuedAt: 1757068800000,
      startsAt: 1757068800000,
      expiresAt: 1759660800000,
      installationId: "VWLB-0094-6114-A3A4-8905",
      diskId: "DSK-A5ED-432A-37DD",
      features: { "users.management": true },
      nonce: "0123456789abcdef",
    }
    const shuffled = {
      nonce: "0123456789abcdef",
      features: { "users.management": true },
      diskId: "DSK-A5ED-432A-37DD",
      installationId: "VWLB-0094-6114-A3A4-8905",
      expiresAt: 1759660800000,
      startsAt: 1757068800000,
      issuedAt: 1757068800000,
      product: "ViewLBA-Server",
      durationDays: 30,
      plan: "monthly",
      customerName: "Lo D'Leo",
      licenseId: "VLBA-aaaaaaaaaaaa",
      v: 2,
    }
    expect(canonicalize(token)).toBe(canonicalize(shuffled))
  })

  it("los enteros grandes (epoch ms) se serializan SIN exponentes ni decimales", () => {
    expect(canonicalize({ t: 1757589000000 })).toBe('{"t":1757589000000}')
  })

  it("caracteres Unicode (ñ, acentos, apóstrofes) se conservan literal", () => {
    expect(canonicalize({ name: "Lo D'Leo" })).toBe('{"name":"Lo D\'Leo"}')
    expect(canonicalize({ name: "D'Leo ñ Ó" })).toBe('{"name":"D\'Leo ñ Ó"}')
  })
})

describe("sortKeysDeep", () => {
  it("no muta el objeto original", () => {
    const obj = { b: 1, a: 2 }
    sortKeysDeep(obj)
    expect(Object.keys(obj)).toEqual(["b", "a"])
  })

  it("arrays de objetos también se ordenan dentro", () => {
    const out = sortKeysDeep({ list: [{ b: 1, a: 2 }] }) as Record<string, unknown>
    const first = (out.list as Record<string, unknown>[])[0]
    expect(Object.keys(first)).toEqual(["a", "b"])
  })
})
