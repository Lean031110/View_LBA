/**
 * Tests: features según plan/estado + watermark (sección 12/13).
 */
import { describe, expect, it } from "bun:test"
import { resolveFeatures, FEATURE_KEYS, FEATURE_LABELS, COMMERCIAL_FEATURES, LIMITED_FEATURES } from "@/lib/licensing/features"
import { CONTACT_PHONE } from "@/lib/licensing/types"

describe("resolveFeatures", () => {
  it("trial: premium bloqueado + watermark visible con días y contacto", () => {
    const f = resolveFeatures({ status: "trial", trialDaysLeft: 5 })
    expect(f.flags["screens.multiDisplay"]).toBe(false)
    expect(f.flags["branding.customLogo"]).toBe(false)
    expect(f.flags["themes.custom"]).toBe(false)
    expect(f.flags["users.management"]).toBe(false)
    expect(f.flags["backup.selfService"]).toBe(false)
    expect(f.flags["display.watermark"]).toBe(true)
    expect(f.watermark).toBe(true)
    expect(f.watermarkLines?.[0]).toBe("VERSIÓN DE PRUEBA · ViewLBA")
    expect(f.watermarkLines?.[1]).toBe("Quedan 5 días")
    expect(f.watermarkLines?.[2]).toContain(CONTACT_PHONE)
    expect(f.lockReason).toBeTruthy()
  })

  it("trial último día: texto singular", () => {
    expect(resolveFeatures({ status: "trial", trialDaysLeft: 1 }).watermarkLines?.[1]).toBe("Queda 1 día")
    expect(resolveFeatures({ status: "trial", trialDaysLeft: 0 }).watermarkLines?.[1]).toBe("Último día de prueba")
  })

  it("active: todo premium habilitado y SIN watermark (sección 13: desaparece)", () => {
    const f = resolveFeatures({ status: "active" })
    expect(f.flags).toEqual(COMMERCIAL_FEATURES)
    expect(f.watermark).toBe(false)
    expect(f.watermarkLines).toBeNull()
    expect(f.lockReason).toBeNull()
  })

  it("grace: producto completo sin watermark", () => {
    const f = resolveFeatures({ status: "grace" })
    expect(f.flags["users.management"]).toBe(true)
    expect(f.watermark).toBe(false)
  })

  it("unlicensed (trial finalizado): watermark de finalización + contacto (sección 14)", () => {
    const f = resolveFeatures({ status: "unlicensed" })
    expect(f.watermark).toBe(true)
    expect(f.watermarkLines?.[0]).toContain("PERÍODO DE PRUEBA FINALIZADO")
    expect(f.watermarkLines?.[1]).toContain(CONTACT_PHONE)
  })

  it("expired: watermark de renovación", () => {
    const f = resolveFeatures({ status: "expired" })
    expect(f.watermarkLines?.[0]).toContain("LICENCIA VENCIDA")
  })

  it("mismatch: watermark de vinculación (mensaje humano del requisito)", () => {
    const f = resolveFeatures({ status: "mismatch" })
    expect(f.watermarkLines?.[0]).toContain("LICENCIA NO CORRESPONDE A ESTE EQUIPO")
  })

  it("invalid: watermark genérico", () => {
    const f = resolveFeatures({ status: "invalid" })
    expect(f.watermark).toBe(true)
  })

  it("features de la licencia SOBRESCRIBEN el plan (preparado para futuros planes, sección 33)", () => {
    const f = resolveFeatures({
      status: "active",
      licenseFeatures: { "users.management": false, "analytics.advanced": true },
    })
    expect(f.flags["users.management"]).toBe(false)
    expect(f.flags["analytics.advanced"]).toBe(true)
    // el watermark NUNCA lo fija la licencia — depende del estado
    expect(f.watermark).toBe(false)
  })
})

describe("invariantes de flags", () => {
  it("todas las feature keys tienen etiqueta legible", () => {
    for (const k of FEATURE_KEYS) {
      expect(FEATURE_LABELS[k].length).toBeGreaterThan(3)
    }
  })

  it("LIMITED == COMMERCIAL salvo watermark y premium", () => {
    for (const k of FEATURE_KEYS) {
      if (k === "display.watermark") {
        expect(LIMITED_FEATURES[k]).toBe(true)
        expect(COMMERCIAL_FEATURES[k]).toBe(false)
      } else {
        expect(LIMITED_FEATURES[k]).toBe(false)
        expect(COMMERCIAL_FEATURES[k]).toBe(true)
      }
    }
  })
})
