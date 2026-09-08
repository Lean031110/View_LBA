/**
 * Tests de validación semántica (FASE 9).
 * Verifica rangos, formatos y coherencia de TODOS los esquemas.
 */
import { describe, it, expect } from "bun:test"
import {
  settingsUpdatePartial,
  promotionCreate,
  promotionUpdate,
  dishCreate,
  scheduleCreate,
  scheduleUpdate,
  socialCreate,
  tickerCreate,
  screenCreate,
  userCreate,
  validateData,
  safeUrl,
  hexColor,
} from "@/lib/validators"

describe("safeUrl — URLs seguras", () => {
  it("acepta http, https y rutas internas relativas", () => {
    expect(validateData(safeUrl, "https://cdn.ejemplo.com/foto.jpg").ok).toBeTrue()
    expect(validateData(safeUrl, "http://192.168.1.5:3000/live.m3u8").ok).toBeTrue()
    expect(validateData(safeUrl, "/api/files/1699123456-abcdef.png").ok).toBeTrue()
  })
  it("rechaza esquemas peligrosos", () => {
    expect(validateData(safeUrl, "javascript:alert(1)").ok).toBeFalse()
    expect(validateData(safeUrl, "data:text/html;base64,xxx").ok).toBeFalse()
    expect(validateData(safeUrl, "file:///etc/passwd").ok).toBeFalse()
    expect(validateData(safeUrl, "no es una url").ok).toBeFalse()
  })
  it("rechaza cadenas vacías", () => {
    expect(validateData(safeUrl, "").ok).toBeFalse()
  })
})

describe("settings — rangos y enums", () => {
  it("valores válidos pasan", () => {
    const r = validateData(settingsUpdatePartial, { audioVolume: 80, tickerSpeed: 55, fontScale: 1, streamRatio: 0.5 })
    expect(r.ok).toBeTrue()
  })
  it("volume fuera de rango → 400 con campo", () => {
    for (const bad of [-500, 100000, -1, 101]) {
      const r = validateData(settingsUpdatePartial, { audioVolume: bad })
      expect(r.ok).toBeFalse()
      expect(r.ok === false && r.field).toBe("audioVolume")
    }
  })
  it("tickerSpeed fuera de 15-150 se rechaza", () => {
    expect(validateData(settingsUpdatePartial, { tickerSpeed: -10 }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { tickerSpeed: 5e9 }).ok).toBeFalse()
  })
  it("fontScale/streamRatio/animationSpeed con rangos", () => {
    expect(validateData(settingsUpdatePartial, { fontScale: -50 }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { fontScale: 1.6 }).ok).toBeTrue()
    expect(validateData(settingsUpdatePartial, { fontScale: 1.61 }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { streamRatio: 0.44 }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { animationSpeed: 0.49 }).ok).toBeFalse()
  })
  it("colores deben ser hex", () => {
    expect(validateData(settingsUpdatePartial, { primaryColor: "#f5a623" }).ok).toBeTrue()
    expect(validateData(settingsUpdatePartial, { primaryColor: "rojo" }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { bgColor: "#12345" }).ok).toBeFalse()
  })
  it("enums estrictos (clockFormat, streamSource, fallbackType)", () => {
    expect(validateData(settingsUpdatePartial, { clockFormat: "25" }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { streamSource: "otro" }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { fallbackType: "iframe" }).ok).toBeFalse()
  })
  it("campos inesperados → rechazo (strict)", () => {
    const r = validateData(settingsUpdatePartial, { hack: 1 })
    expect(r.ok).toBeFalse()
  })
  it("rtmpPort 1-65535 y rtmpApp alfanumérico", () => {
    expect(validateData(settingsUpdatePartial, { rtmpPort: 99999 }).ok).toBeFalse()
    expect(validateData(settingsUpdatePartial, { rtmpApp: "../evil" }).ok).toBeFalse()
  })
})

describe("promotions", () => {
  it("promo válida pasa", () => {
    const r = validateData(promotionCreate, {
      title: "2x1 Pizzas",
      duration: 10,
      priority: 0,
      order: 0,
      active: true,
      startTime: "12:00",
      endTime: "20:00",
      startDate: null,
      endDate: null,
    })
    expect(r.ok).toBeTrue()
  })
  it("duration fuera de 4-600 se rechaza", () => {
    const r = validateData(promotionCreate, {
      title: "X",
      duration: -5,
      priority: 0,
      order: 0,
      active: true,
      startTime: null,
      endTime: null,
      startDate: null,
      endDate: null,
    })
    expect(r.ok).toBeFalse()
  })
  it("horas inválidas se rechazan (25:00, 8:5)", () => {
    expect(
      validateData(promotionCreate, {
        title: "X", duration: 10, priority: 0, order: 0, active: true,
        startTime: "25:00", endTime: null, startDate: null, endDate: null,
      }).ok
    ).toBeFalse()
    expect(
      validateData(promotionCreate, {
        title: "X", duration: 10, priority: 0, order: 0, active: true,
        startTime: null, endTime: "8:5", startDate: null, endDate: null,
      }).ok
    ).toBeFalse()
  })
  it("startDate > endDate se rechaza", () => {
    const r = validateData(promotionCreate, {
      title: "X", duration: 10, priority: 0, order: 0, active: true,
      startTime: null, endTime: null,
      startDate: "2026-12-31T00:00:00Z",
      endDate: "2026-01-01T00:00:00Z",
    })
    expect(r.ok).toBeFalse()
    expect(r.ok === false && r.field).toBe("endDate")
  })
  it("imageUrl javascript: se rechaza", () => {
    const r = validateData(promotionCreate, {
      title: "X", duration: 10, priority: 0, order: 0, active: true,
      startTime: null, endTime: null, startDate: null, endDate: null,
      imageUrl: "javascript:alert(1)",
    })
    expect(r.ok).toBeFalse()
  })
  it("update parcial solo valida lo presente", () => {
    expect(validateData(promotionUpdate, { duration: 30 }).ok).toBeTrue()
    expect(validateData(promotionUpdate, { duration: 99999 }).ok).toBeFalse()
  })
})

describe("dishes", () => {
  it("dayOfWeek 0-6 (null = cualquier día)", () => {
    expect(validateData(dishCreate, { name: "Salmón", order: 0, active: true, dayOfWeek: 6 }).ok).toBeTrue()
    expect(validateData(dishCreate, { name: "Salmón", order: 0, active: true, dayOfWeek: 7 }).ok).toBeFalse()
    expect(validateData(dishCreate, { name: "Salmón", order: 0, active: true, dayOfWeek: 99 }).ok).toBeFalse()
    expect(validateData(dishCreate, { name: "Salmón", order: 0, active: true, dayOfWeek: null }).ok).toBeTrue()
  })
})

describe("schedules", () => {
  it("franja normal y overnight (22:00→02:00) pasan", () => {
    expect(validateData(scheduleCreate, { name: "CENA", startTime: "18:00", endTime: "23:00", dayOfWeek: null, order: 0, active: true }).ok).toBeTrue()
    expect(validateData(scheduleCreate, { name: "NOCHE", startTime: "22:00", endTime: "02:00", dayOfWeek: null, order: 0, active: true }).ok).toBeTrue()
  })
  it("horas inválidas o iguales se rechazan", () => {
    expect(validateData(scheduleCreate, { name: "X", startTime: "99:00", endTime: "02:00", dayOfWeek: null, order: 0, active: true }).ok).toBeFalse()
    expect(validateData(scheduleCreate, { name: "X", startTime: "12:00", endTime: "12:00", dayOfWeek: null, order: 0, active: true }).ok).toBeFalse()
  })
  it("color debe ser hex", () => {
    expect(validateData(scheduleCreate, { name: "X", startTime: "07:00", endTime: "11:00", dayOfWeek: null, order: 0, active: true, color: "azul" }).ok).toBeFalse()
    expect(validateData(scheduleCreate, { name: "X", startTime: "07:00", endTime: "11:00", dayOfWeek: null, order: 0, active: true, color: "#f5a623" }).ok).toBeTrue()
  })
  it("update parcial permite cambiar solo el nombre", () => {
    expect(validateData(scheduleUpdate, { name: "MERIENDA" }).ok).toBeTrue()
  })
})

describe("socials", () => {
  it("network del enum y url http(s)", () => {
    expect(validateData(socialCreate, { network: "INSTAGRAM", username: "@casa", url: "https://instagram.com/casa", order: 0, active: true }).ok).toBeTrue()
    expect(validateData(socialCreate, { network: "DISCORD", username: null, url: null, order: 0, active: true }).ok).toBeFalse()
    expect(validateData(socialCreate, { network: "FACEBOOK", username: null, url: "javascript:x", order: 0, active: true }).ok).toBeFalse()
  })
})

describe("ticker", () => {
  it("texto ≤ 200 y order 0-9999", () => {
    expect(validateData(tickerCreate, { text: "Hola", order: 0, active: true }).ok).toBeTrue()
    expect(validateData(tickerCreate, { text: "x".repeat(201), order: 0, active: true }).ok).toBeFalse()
    expect(validateData(tickerCreate, { text: "Hola", order: 99999, active: true }).ok).toBeFalse()
  })
})

describe("screens", () => {
  it("código con formato TV-004", () => {
    expect(validateData(screenCreate, { code: "TV-004", name: "Terraza", location: null, notes: null, active: true }).ok).toBeTrue()
    expect(validateData(screenCreate, { code: "", name: "X", location: null, notes: null, active: true }).ok).toBeFalse()
    expect(validateData(screenCreate, { code: "tv-4 minúsculas", name: "X", location: null, notes: null, active: true }).ok).toBeFalse()
    expect(validateData(screenCreate, { code: "TV;DROP TABLE", name: "X", location: null, notes: null, active: true }).ok).toBeFalse()
  })
})

describe("users (política de contraseña FASE 17)", () => {
  it("contraseña fuerte válida", () => {
    expect(validateData(userCreate, { email: "a@b.com", name: "A", role: "OPERATOR", active: true, password: "MiClave12345" }).ok).toBeTrue()
  })
  it("cortas/débiles rechazadas", () => {
    for (const bad of ["admin123", "corta1A", "SINNUMEROSaa", "sinmayuscula123"]) {
      expect(validateData(userCreate, { email: "a@b.com", name: "A", role: "OPERATOR", active: true, password: bad }).ok).toBeFalse()
    }
  })
  it("email inválido rechazado", () => {
    expect(validateData(userCreate, { email: "no-email", name: "A", role: "OPERATOR", active: true, password: "MiClave12345" }).ok).toBeFalse()
  })
})

describe("hexColor", () => {
  it("formato #RGB y #RRGGBB", () => {
    expect(validateData(hexColor, "#f5a623").ok).toBeTrue()
    expect(validateData(hexColor, "#f52").ok).toBeTrue()
    expect(validateData(hexColor, "#GGGGGG").ok).toBeFalse()
  })
})
