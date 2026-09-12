/**
 * TESTS — Validadores de schema (manifest.json + theme.json).
 *
 * §24: NUNCA interpretar un schema desconocido → unknown keys = rechazo.
 */
import { describe, it, expect } from "bun:test"
import { validateManifest, validateThemeSpec, semverLessThan } from "@/lib/themes/validate"
import { ThemeError } from "@/lib/themes/types"
import { baseManifest, baseSpec } from "./helpers"

function expectThemeError(fn: () => unknown, code: string, label: string) {
  try {
    fn()
    throw new Error(`DEBÍA RECHAZAR (${label})`)
  } catch (e) {
    expect(e instanceof ThemeError).toBe(true)
    expect((e as ThemeError).code).toBe(code)
  }
}

const V = "3.1.0"

describe("validateManifest — válido", () => {
  it("manifest canónico pasa y se normaliza (hex a minúsculas en spec)", () => {
    const m = validateManifest(baseManifest(), V)
    expect(m.id).toBe("test-theme")
    expect(m.schemaVersion).toBe(1)
    expect(m.licenseTier).toBe("full")
  })

  it("spec canónico pasa (todos los campos válidos)", () => {
    const s = validateThemeSpec(baseSpec())
    expect(s.palette?.primary).toBe("#123456")
    expect(s.clock?.style).toBe("digital")
  })

  it("spec VACÍO pasa (todo opcional → defaults del Default al merge)", () => {
    expect(validateThemeSpec({})).toEqual({})
  })
})

describe("validateManifest — rechazos", () => {
  it("schemaVersion 2 (futuro) → bad_schema (nunca interpretar desconocido)", () => {
    expectThemeError(() => validateManifest(baseManifest({ schemaVersion: 2 }), V), "bad_schema", "schema 2")
  })

  it("schemaVersion 0 / string / float → rechazo", () => {
    expectThemeError(() => validateManifest({ ...baseManifest(), schemaVersion: 0 }, V), "bad_schema", "schema 0")
    expectThemeError(() => validateManifest({ ...baseManifest(), schemaVersion: "1" }, V), "bad_field", "schema string")
    expectThemeError(() => validateManifest({ ...baseManifest(), schemaVersion: 1.5 }, V), "bad_schema", "schema 1.5")
  })

  it("campo desconocido en manifest → unknown_field", () => {
    expectThemeError(() => validateManifest({ ...baseManifest(), extra: "x" }, V), "unknown_field", "campo extra")
  })

  it("id inválido (mayúsculas/short/símbolos) → bad_field", () => {
    expectThemeError(() => validateManifest(baseManifest({ id: "Bad-ID" }), V), "bad_field", "id mayúsculas")
    expectThemeError(() => validateManifest(baseManifest({ id: "ab" }), V), "bad_field", "id corto")
    expectThemeError(() => validateManifest(baseManifest({ id: "has space" }), V), "bad_field", "id con espacio")
    expectThemeError(() => validateManifest(baseManifest({ id: "../evil" }), V), "bad_field", "id traversal")
  })

  it("version no semver → bad_field", () => {
    expectThemeError(() => validateManifest(baseManifest({ version: "1.0" }), V), "bad_field", "1.0")
    expectThemeError(() => validateManifest(baseManifest({ version: "1.0.0-beta" }), V), "bad_field", "sufijo")
  })

  it("minViewLbaVersion futuro → incompatible", () => {
    expectThemeError(() => validateManifest(baseManifest({ minViewLbaVersion: "3.2.0" }), V), "incompatible", "3.2.0")
    expectThemeError(() => validateManifest(baseManifest({ minViewLbaVersion: "99.0.0" }), V), "incompatible", "99.0.0")
  })

  it("minViewLbaVersion igual/menor pasa", () => {
    expect(validateManifest(baseManifest({ minViewLbaVersion: "3.1.0" }), V).id).toBe("test-theme")
    expect(validateManifest(baseManifest({ minViewLbaVersion: "3.0.0" }), V).id).toBe("test-theme")
    expect(validateManifest(baseManifest({ minViewLbaVersion: "2.0.0" }), V).id).toBe("test-theme")
  })

  it("licenseTier != full → wrong_tier", () => {
    expectThemeError(() => validateManifest({ ...baseManifest(), licenseTier: "trial" }, V), "wrong_tier", "tier trial")
    expectThemeError(() => validateManifest({ ...baseManifest(), licenseTier: "free" }, V), "wrong_tier", "tier free")
  })

  it("tipos incorrectos → bad_field", () => {
    expectThemeError(() => validateManifest({ ...baseManifest(), name: 42 }, V), "bad_field", "name número")
    expectThemeError(() => validateManifest({ ...baseManifest(), description: null }, V), "bad_field", "desc null")
  })

  it("longitudes excesivas → bad_field", () => {
    expectThemeError(() => validateManifest(baseManifest({ name: "x".repeat(81) }), V), "bad_field", "name 81")
    expectThemeError(() => validateManifest(baseManifest({ description: "x".repeat(401) }), V), "bad_field", "desc 401")
    expectThemeError(() => validateManifest(baseManifest({ id: "a".repeat(65) }), V), "bad_field", "id 65")
  })

  it("no objeto (array/null/string) → bad_json", () => {
    expectThemeError(() => validateManifest(null, V), "bad_json", "null")
    expectThemeError(() => validateManifest([1, 2], V), "bad_json", "array")
    expectThemeError(() => validateManifest("manifest", V), "bad_json", "string")
  })

  it("semverLessThan funciona por componentes (no lexicográfico)", () => {
    expect(semverLessThan("3.1.0", "3.10.0")).toBe(true) // 1 < 10 numérico
    expect(semverLessThan("3.10.0", "3.9.9")).toBe(false)
    expect(semverLessThan("3.1.0", "3.1.0")).toBe(false)
  })
})

describe("validateThemeSpec — rechazos", () => {
  it("campo desconocido en theme.json → unknown_field (§24)", () => {
    expectThemeError(() => validateThemeSpec({ evil: true }), "unknown_field", "raíz extra")
    expectThemeError(() => validateThemeSpec({ palette: { primary: "#123456", extra: 1 } }), "unknown_field", "palette extra")
    expectThemeError(() => validateThemeSpec({ cards: { radius: 4, shadow: "soft", glow: 1 } }), "unknown_field", "cards extra")
  })

  it("colores no hex → bad_field", () => {
    expectThemeError(() => validateThemeSpec({ palette: { primary: "red" } }), "bad_field", "nombre de color")
    expectThemeError(() => validateThemeSpec({ palette: { primary: "#12345" } }), "bad_field", "5 dígitos")
    expectThemeError(() => validateThemeSpec({ palette: { primary: "#12345678" } }), "bad_field", "8 dígitos")
    expectThemeError(() => validateThemeSpec({ palette: { primary: 123 } }), "bad_field", "número")
  })

  it("enums inválidos → bad_field (con lista de permitidos)", () => {
    expectThemeError(() => validateThemeSpec({ clock: { style: "hologram" } }), "bad_field", "clock inventado")
    expectThemeError(() => validateThemeSpec({ ticker: { style: "retro" } }), "bad_field", "ticker inventado")
    expectThemeError(() => validateThemeSpec({ carousel: { transition: "flip3d" } }), "bad_field", "carousel inventado")
    expectThemeError(() => validateThemeSpec({ background: { effect: "video" } }), "bad_field", "bg video")
    expectThemeError(() => validateThemeSpec({ cards: { shadow: "hard" } }), "bad_field", "shadow inventado")
    expectThemeError(() => validateThemeSpec({ typography: { heading: "comic-sans" } }), "bad_field", "font inventada")
  })

  it("cards.radius fuera de rango / no entero → bad_field", () => {
    expectThemeError(() => validateThemeSpec({ cards: { radius: 33 } }), "bad_field", "radius 33")
    expectThemeError(() => validateThemeSpec({ cards: { radius: -1 } }), "bad_field", "radius -1")
    expectThemeError(() => validateThemeSpec({ cards: { radius: 4.5 } }), "bad_field", "radius 4.5")
  })

  it("assets.backgroundImage con traversal → bad_asset_ref", () => {
    expectThemeError(() => validateThemeSpec({ assets: { backgroundImage: "../../evil.png" } }), "bad_asset_ref", "traversal")
    expectThemeError(() => validateThemeSpec({ assets: { backgroundImage: "sub/dir.png" } }), "bad_asset_ref", "subdir")
    expectThemeError(() => validateThemeSpec({ assets: { backgroundImage: "" } }), "bad_asset_ref", "vacío")
  })

  it("assets.backgroundImage null explícito pasa (sin imagen)", () => {
    expect(validateThemeSpec({ assets: { backgroundImage: null } })).toEqual({ assets: { backgroundImage: null } })
  })

  it("tipos incorrectos → bad_field", () => {
    expectThemeError(() => validateThemeSpec({ cards: "rounded" }), "bad_field", "cards string")
    expectThemeError(() => validateThemeSpec({ typography: null }), "bad_field", "typography null")
    expectThemeError(() => validateThemeSpec({ palette: [1, 2] }), "bad_field", "palette array")
  })
})
