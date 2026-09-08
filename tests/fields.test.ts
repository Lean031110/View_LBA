import { describe, expect, it } from "bun:test"
import { pickFields, readBody } from "@/lib/fields"

describe("pickFields — validación de campos del body", () => {
  it("normaliza strings requeridos y convierte vacíos a null en nullable", () => {
    const out = pickFields({ title: "Promo", note: "" }, { title: "s", note: "s?" })
    expect(out).toEqual({ title: "Promo", note: null })
  })

  it("descarta campos que no están en el spec y conserva null explícitos", () => {
    const out = pickFields({ a: "x", extra: "no-va" }, { a: "s?" })
    expect(out).toEqual({ a: "x" })
  })

  it("convierte a número y usa 0 cuando no es finito", () => {
    const out = pickFields({ n: "12", bad: "abc", j: "3.5" }, { n: "n", bad: "n", j: "n" })
    expect(out).toEqual({ n: 12, bad: 0, j: 3.5 })
  })

  it("números nullable: vacío/null → null, inválido → null", () => {
    const out = pickFields({ a: "", b: null, c: "no", d: "7" }, { a: "n?", b: "n?", c: "n?", d: "n?" })
    expect(out).toEqual({ a: null, b: null, c: null, d: 7 })
  })

  it("booleanos estrictos: true o 'true'", () => {
    const out = pickFields({ a: true, b: "true", c: "1", d: false }, { a: "b", b: "b", c: "b", d: "b" })
    expect(out).toEqual({ a: true, b: true, c: false, d: false })
  })

  it("fechas nullable: ISO válido → Date, resto → null", () => {
    const out = pickFields({ ok: "2026-01-02T10:00:00Z", empty: "", nulo: null }, { ok: "d?", empty: "d?", nulo: "d?" })
    expect((out.ok as Date).toISOString()).toBe("2026-01-02T10:00:00.000Z")
    expect(out.empty).toBeNull()
    expect(out.nulo).toBeNull()
  })

  it("descarta specs con tipo desconocido (defensa en profundidad)", () => {
    const out = pickFields({ a: "x" }, { a: "tipo-inventado", b: "s" })
    expect(out).toEqual({})
  })

  it("no muta el body original", () => {
    const body = { title: "Original" }
    pickFields(body, { title: "s" })
    expect(body).toEqual({ title: "Original" })
  })
})

describe("readBody — lectura tolerante", () => {
  it("devuelve el objeto JSON de un Request válido", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    })
    const out = await readBody(req as never)
    expect(out).toEqual({ ok: true })
  })

  it("devuelve {} ante un body inválido", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "no-json{",
    })
    const out = await readBody(req as never)
    expect(out).toEqual({})
  })
})
