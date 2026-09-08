import { describe, expect, it } from "bun:test"
import { APP_NAME, APP_TAGLINE, APP_VERSION, APP_LOGO, APP_LOGO_MARK, APP_DESCRIPTION } from "@/lib/brand"

describe("brand — identidad ViewLBA (fuente única de verdad)", () => {
  it("nombre y versión con formato semántico", () => {
    expect(APP_NAME).toBe("ViewLBA")
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("recursos de logo servidos desde /public", () => {
    expect(APP_LOGO).toBe("/logo.svg")
    expect(APP_LOGO_MARK).toBe("/logo-mark.svg")
  })

  it("tagline y descripción no vacíos", () => {
    expect(APP_TAGLINE.length).toBeGreaterThan(0)
    expect(APP_DESCRIPTION.length).toBeGreaterThan(20)
  })
})
