/**
 * Utilidades de timezone del restaurante (FASE 8 de la misión).
 *
 * PROBLEMA que resuelve: el reloj/horarios/promos/platos se evaluaban con la
 * hora LOCAL DEL NAVEGADOR de la TV (getHours/getDay). Si el TV tiene otra
 * zona o un reloj desviado, el contenido visible era incorrecto.
 *
 * SOLUCIÓN: TODA la lógica de programación de contenido pasa por estas
 * funciones, que convierten "ahora" a la zona horaria configurada del
 * restaurante (Settings.timezone, default America/Havana) usando
 * Intl.DateTimeFormat — sin mezclar UTC/hora local/hora del restaurante.
 */

export interface TimeParts {
  /** Año/mes/día EN LA ZONA DEL RESTAURANTE */
  year: number
  month: number // 1-12
  day: number // 1-31
  /** 0=domingo … 6=sábado EN LA ZONA DEL RESTAURANTE */
  weekday: number
  hour: number // 0-23
  minute: number // 0-59
  /** Minutos desde medianoche EN LA ZONA DEL RESTAURANTE (0-1439) */
  minutes: number
  /** Fecha ISO YYYY-MM-DD EN LA ZONA DEL RESTAURANTE */
  isoDate: string
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

// Cache de formatters por zona (el reloj consulta cada segundo)
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    formatterCache.set(timezone, fmt)
  }
  return fmt
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Zona segura: inválida/vacía → UTC (nunca lanza) */
export function safeTimezone(timezone: string | null | undefined): string {
  const tz = (timezone ?? "").trim()
  if (!tz) return "UTC"
  return isValidTimezone(tz) ? tz : "UTC"
}

/**
 * Parte un instante (Date/epoch ms) en componentes de la zona del restaurante.
 * Fuente única de verdad para TODO el contenido programado.
 */
export function getTimeParts(now: Date | number, timezone: string): TimeParts {
  const date = now instanceof Date ? now : new Date(now)
  const parts = getFormatter(safeTimezone(timezone)).formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ""

  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  const weekday = WEEKDAYS[get("weekday")] ?? 0
  // hour "24" aparece con hour12:false en algunas ICU para medianoche
  const hour = Number(get("hour")) % 24
  const minute = Number(get("minute"))
  const minutes = hour * 60 + minute
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`

  return { year, month, day, weekday, hour, minute, minutes, isoDate }
}

/** ¿La fecha ISO (YYYY-MM-DD, zona restaurante) de HOY? */
export function isTodayIso(isoDate: string | null | undefined, timezone: string): boolean {
  if (!isoDate) return false
  return isoDate.slice(0, 10) === getTimeParts(Date.now(), timezone).isoDate
}

/** "HH:MM" | "HH:MM:SS" → minutos desde medianoche (null si inválido) */
export function hhmmToMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * ¿Los minutos actuales están dentro de la ventana [start, end)?
 * Soporta ventanas que CRUZAN MEDIANOCHE (22:00→02:00): si end <= start,
 * la ventana activa es minutes >= start O minutes < end.
 */
export function inTimeWindow(minutes: number, startMinutes: number, endMinutes: number): boolean {
  if (endMinutes > startMinutes) return minutes >= startMinutes && minutes < endMinutes
  // overnight: 22:00 → 02:00
  return minutes >= startMinutes || minutes < endMinutes
}

/**
 * ¿Una promoción está dentro de su ventana de fecha/hora (en la zona del
 * restaurante)? Equivalente a promoVisible de TvDisplay, pero timezone-aware.
 */
export interface TimeWindow {
  startDate?: string | null // ISO
  endDate?: string | null // ISO
  startTime?: string | null // "HH:MM"
  endTime?: string | null // "HH:MM"
}

export function inPromoWindow(parts: TimeParts, now: Date, w: TimeWindow): boolean {
  if (w.startDate && now < new Date(w.startDate)) return false
  if (w.endDate && now > new Date(w.endDate)) return false
  if (w.startTime || w.endTime) {
    const start = w.startTime ? hhmmToMinutes(w.startTime) : null
    const end = w.endTime ? hhmmToMinutes(w.endTime) : null
    // horas inválidas guardadas (legado) → no filtrar por hora
    if (start === null && end === null) return true
    const s = start ?? 0
    const e = end ?? 24 * 60
    if (!inTimeWindow(parts.minutes, s, e)) return false
  }
  return true
}

/** Elegir platos/sugerencias para HOY (zona restaurante):
 *  fecha específica → día de semana → genéricos → cualquier primero. */
export function pickDishesForToday<T extends { date?: string | null; dayOfWeek?: number | null }>(
  parts: TimeParts,
  dishes: T[]
): T[] {
  const byDate = dishes.filter((d) => d.date && d.date.slice(0, 10) === parts.isoDate)
  const byDay = dishes.filter((d) => d.dayOfWeek === parts.weekday && !d.date)
  const generic = dishes.filter((d) => d.dayOfWeek == null && !d.date)
  if (byDate.length > 0) return byDate
  if (byDay.length > 0) return byDay
  if (generic.length > 0) return generic
  return dishes.slice(0, 1)
}
