/**
 * Tests de timezone del restaurante (FASE 8).
 * Instantes fijos (epoch) → conversiones verificadas contra ICU.
 * Cubre: America/Havana, cambio de día local, DST (America/New_York),
 * ventanas overnight 22:00→02:00, validación HH:MM y selección de platos.
 */
import { describe, it, expect } from "bun:test"
import {
  getTimeParts,
  safeTimezone,
  isTodayIso,
  hhmmToMinutes,
  inTimeWindow,
  inPromoWindow,
  pickDishesForToday,
} from "@/lib/timezone"

// 2026-09-08T22:30:00Z → La Habana 18:30 (UTC-4, horario de verano)
const HAVANA_EVENING = new Date("2026-09-08T22:30:00Z")
// 2026-09-09T02:30:00Z → La Habana 22:30 DEL MISMO 8 de septiembre
const HAVANA_NIGHT = new Date("2026-09-09T02:30:00Z")

describe("getTimeParts — America/Havana", () => {
  it("convierte a la hora local del restaurante (no la del navegador ni UTC)", () => {
    const p = getTimeParts(HAVANA_EVENING, "America/Havana")
    expect(p.hour).toBe(18)
    expect(p.minute).toBe(30)
    expect(p.minutes).toBe(18 * 60 + 30)
  })

  it("fecha ISO y weekday en la zona del restaurante", () => {
    const p = getTimeParts(HAVANA_EVENING, "America/Havana")
    expect(p.isoDate).toBe("2026-09-08")
    expect(p.weekday).toBe(2) // martes
  })

  it("el día cambia a medianoche LOCAL, no a medianoche UTC", () => {
    // 02:30 UTC del día 9 sigue siendo 22:30 del día 8 en La Habana
    const p = getTimeParts(HAVANA_NIGHT, "America/Havana")
    expect(p.isoDate).toBe("2026-09-08")
    expect(p.hour).toBe(22)
  })

  it("medianoche local exacta cambia el día", () => {
    // 2026-09-09T04:00:00Z = 00:00 del 9 en La Habana
    const p = getTimeParts(new Date("2026-09-09T04:00:00Z"), "America/Havana")
    expect(p.isoDate).toBe("2026-09-09")
    expect(p.hour).toBe(0)
    expect(p.minutes).toBe(0)
    expect(p.weekday).toBe(3) // miércoles
  })
})

describe("getTimeParts — DST (America/New_York)", () => {
  it("antes del salto: UTC-5", () => {
    const p = getTimeParts(new Date("2026-03-08T05:00:00Z"), "America/New_York")
    expect(p.hour).toBe(0)
    expect(p.minutes).toBe(0)
  })
  it("después del salto (2:00→3:00): UTC-4, la hora 2 no existe", () => {
    const p = getTimeParts(new Date("2026-03-08T07:00:00Z"), "America/New_York")
    expect(p.hour).toBe(3)
  })
})

describe("safeTimezone", () => {
  it("zona inválida/vacía → UTC sin lanzar", () => {
    expect(safeTimezone("Zona/Inventada")).toBe("UTC")
    expect(safeTimezone("")).toBe("UTC")
    expect(safeTimezone(null)).toBe("UTC")
    expect(safeTimezone(undefined)).toBe("UTC")
  })
  it("zona válida se conserva", () => {
    expect(safeTimezone("America/Havana")).toBe("America/Havana")
  })
})

describe("isTodayIso", () => {
  it("compara con la fecha de HOY en la zona del restaurante", () => {
    const today = getTimeParts(Date.now(), "America/Havana").isoDate
    expect(isTodayIso(today, "America/Havana")).toBeTrue()
    expect(isTodayIso("1999-01-01", "America/Havana")).toBeFalse()
    expect(isTodayIso(null, "America/Havana")).toBeFalse()
  })
})

describe("hhmmToMinutes", () => {
  it("parsea HH:MM y HH:MM:SS", () => {
    expect(hhmmToMinutes("00:00")).toBe(0)
    expect(hhmmToMinutes("08:30")).toBe(510)
    expect(hhmmToMinutes("22:00:30")).toBe(1320)
  })
  it("rechaza formatos inválidos (datos corruptos de DB)", () => {
    expect(hhmmToMinutes("25:00")).toBeNull()
    expect(hhmmToMinutes("12:75")).toBeNull()
    expect(hhmmToMinutes("abc")).toBeNull()
    expect(hhmmToMinutes(null)).toBeNull()
    expect(hhmmToMinutes("")).toBeNull()
  })
})

describe("inTimeWindow — overnight 22:00→02:00", () => {
  const start = 22 * 60
  const end = 2 * 60
  it("23:00 está dentro (después de empezar, cruzando medianoche)", () => {
    expect(inTimeWindow(23 * 60, start, end)).toBeTrue()
  })
  it("01:00 está dentro (madrugada del día siguiente)", () => {
    expect(inTimeWindow(60, start, end)).toBeTrue()
  })
  it("03:00 está fuera", () => {
    expect(inTimeWindow(180, start, end)).toBeFalse()
  })
  it("21:59 está fuera (antes de empezar)", () => {
    expect(inTimeWindow(21 * 60 + 59, start, end)).toBeFalse()
  })
  it("ventana normal 07:00→11:00 funciona igual", () => {
    expect(inTimeWindow(8 * 60, 7 * 60, 11 * 60)).toBeTrue()
    expect(inTimeWindow(12 * 60, 7 * 60, 11 * 60)).toBeFalse()
  })
})

describe("inPromoWindow (promos con fecha/hora en zona restaurante)", () => {
  const parts = getTimeParts(HAVANA_EVENING, "America/Havana") // martes 18:30

  it("ventana de hora 12:00→20:00 incluye 18:30", () => {
    expect(inPromoWindow(parts, HAVANA_EVENING, { startTime: "12:00", endTime: "20:00" })).toBeTrue()
  })
  it("ventana de hora 20:00→23:00 excluye 18:30", () => {
    expect(inPromoWindow(parts, HAVANA_EVENING, { startTime: "20:00", endTime: "23:00" })).toBeFalse()
  })
  it("promo overnight 22:00→02:00 activa a las 22:30 (mismo día, hora local)", () => {
    const night = getTimeParts(HAVANA_NIGHT, "America/Havana")
    expect(inPromoWindow(night, HAVANA_NIGHT, { startTime: "22:00", endTime: "02:00" })).toBeTrue()
  })
  it("endDate ya pasada → inactiva", () => {
    expect(inPromoWindow(parts, HAVANA_EVENING, { endDate: "2026-01-01T00:00:00Z" })).toBeFalse()
  })
  it("startDate futura → inactiva", () => {
    expect(inPromoWindow(parts, HAVANA_EVENING, { startDate: "2027-01-01T00:00:00Z" })).toBeFalse()
  })
  it("sin restricciones → activa", () => {
    expect(inPromoWindow(parts, HAVANA_EVENING, {})).toBeTrue()
  })
})

describe("pickDishesForToday (sugerencias por día)", () => {
  const parts = getTimeParts(HAVANA_EVENING, "America/Havana") // martes 2026-09-08
  const dishes = [
    { id: "1", name: "generico", date: null, dayOfWeek: null },
    { id: "2", name: "martes", date: null, dayOfWeek: 2 },
    { id: "3", name: "sabado", date: null, dayOfWeek: 6 },
    { id: "4", name: "fecha-especifica", date: "2026-09-08T00:00:00.000Z", dayOfWeek: null },
    { id: "5", name: "otra-fecha", date: "2026-12-25T00:00:00.000Z", dayOfWeek: null },
  ]

  it("la fecha específica de HOY gana sobre día de semana y genéricos", () => {
    const sel = pickDishesForToday(parts, dishes)
    expect(sel.map((d) => d.id)).toEqual(["4"])
  })
  it("sin fecha específica, el día de la semana (martes=2) gana", () => {
    const noDate = dishes.filter((d) => !d.date)
    const sel = pickDishesForToday(parts, noDate)
    expect(sel.map((d) => d.id)).toEqual(["2"])
  })
  it("solo genéricos → devuelve los genéricos", () => {
    const sel = pickDishesForToday(parts, [{ id: "g1", date: null, dayOfWeek: null }])
    expect(sel.map((d) => d.id)).toEqual(["g1"])
  })
  it("nada coincide → primer plato como respaldo (comportamiento actual)", () => {
    const sel = pickDishesForToday(parts, [{ id: "x", date: "1999-01-01T00:00:00Z", dayOfWeek: 5 }])
    expect(sel.map((d) => d.id)).toEqual(["x"])
  })
  it("la fecha se compara en ZONA RESTAURANTE: 2026-09-09T02:30Z sigue siendo el 8 en La Habana", () => {
    const nightParts = getTimeParts(HAVANA_NIGHT, "America/Havana")
    const sel = pickDishesForToday(nightParts, dishes)
    expect(sel.map((d) => d.id)).toEqual(["4"]) // sigue siendo martes 8
  })
})
