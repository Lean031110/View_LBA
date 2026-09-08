/**
 * Validación semántica centralizada con Zod (FASE 9 de la misión).
 *
 * ANTES: pickFields solo normalizaba TIPOS (string/number/boolean) — un
 * volume=-500, tickerSpeed=5e9, dayOfWeek=99 o una URL javascript: se
 * guardaban sin rechazo.
 *
 * AHORA: cada ruta POST/PUT valida los datos NORMALIZADOS contra estos
 * esquemas y devuelve 400 consistente { error, field }.
 */
import { z } from "zod"

// ---------- Bloques reutilizables ----------

/** URL absoluta http(s) o ruta relativa interna (/api/files/...) — nunca javascript:/data: */
export const safeUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) => {
      if (v.startsWith("/")) return true // ruta interna del propio servidor
      try {
        const u = new URL(v)
        return u.protocol === "http:" || u.protocol === "https:"
      } catch {
        return false
      }
    },
    { message: "Debe ser http(s):// o una ruta interna que empiece por /" }
  )

/** Acepta valor | null | undefined (campo ausente en el body) */
const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

const nullableSafeUrl = nullish(safeUrl)

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color hex inválido (#RRGGBB)")
  .or(z.string().regex(/^#[0-9a-fA-F]{3}$/, "Color hex inválido (#RGB)"))

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (formato HH:MM)")

const isoDate = z.union([z.string().min(1), z.null()]) // Prisma espera string ISO; coherencia fechas abajo

/** Fecha válida (string ISO o Date — pickFields ya convierte) o null/undefined */
const dateValue = z
  .union([
    z.string().min(1).refine((s) => !Number.isNaN(Date.parse(s)), { message: "Fecha inválida (ISO)" }),
    z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "Fecha inválida" }),
  ])
  .nullable()
  .optional()

/** epoch ms de una fecha (string ISO o Date) para comparaciones */
function epochOf(v: string | Date | null | undefined): number | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

const order = z.number().int().min(0).max(9999)
const screenCode = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, "Código inválido: 2-16 caracteres, mayúsculas/números/guion (ej. TV-004)")
const name = z.string().trim().min(1).max(120)
const text200 = z.string().trim().min(1).max(200)
const description = nullish(z.string().trim().max(1000))

// ---------- Settings (PUT /api/admin/settings) ----------

export const settingsUpdate = z
  .object({
    restaurantName: z.string().trim().min(1).max(80),
    logoUrl: nullableSafeUrl,
    logoSize: z.enum(["sm", "md", "lg"]),
    logoPosition: z.enum(["left", "center", "right"]),
    clockFormat: z.enum(["12", "24"]),
    showDate: z.boolean(),
    showSeconds: z.boolean(),
    showDay: z.boolean(),
    timezone: z.string().trim().min(1).max(64),
    language: z.string().trim().min(2).max(8),
    streamSource: z.enum(["local", "external"]),
    rtmpPort: z.number().int().min(1).max(65535),
    rtmpApp: z.string().trim().regex(/^[a-z0-9_-]{1,24}$/i, "App RTMP inválida (1-24, alfanumérico/guiones)"),
    rtmpHost: nullish(z.string().trim().max(255)),
    streamEnabled: z.boolean(),
    streamUrl: nullableSafeUrl,
    streamProtocol: z.enum(["hls", "mp4"]),
    autoplay: z.boolean(),
    reconnectBehavior: z.enum(["auto", "manual"]),
    fallbackType: z.enum(["message", "image", "video"]),
    fallbackMessage: z.string().trim().min(1).max(200),
    fallbackImageUrl: nullableSafeUrl,
    fallbackVideoUrl: nullableSafeUrl,
    audioVolume: z.number().int().min(0).max(100),
    audioMuted: z.boolean(),
    audioDeviceId: nullish(z.string().max(128)),
    audioAutoUnmute: z.boolean(),
    tickerEnabled: z.boolean(),
    tickerSpeed: z.number().int().min(15).max(150),
    tickerPaused: z.boolean(),
    primaryColor: hexColor,
    accentColor: hexColor,
    bgColor: hexColor,
    surfaceColor: hexColor,
    fontScale: z.number().min(0.7).max(1.6),
    streamRatio: z.number().min(0.45).max(0.8),
    animationsEnabled: z.boolean(),
    animationSpeed: z.number().min(0.5).max(2),
    showPromotions: z.boolean(),
    showDish: z.boolean(),
    showSocials: z.boolean(),
    showSchedule: z.boolean(),
    showTicker: z.boolean(),
  })
  .strict() // campos inesperados → error (defensa en profundidad; streamKey ya se bloquea antes)

export const settingsUpdatePartial = settingsUpdate.partial()

// ---------- Promotions ----------

const promotionShape = z.object({
  title: name,
  description,
  price: nullish(z.string().trim().max(40)),
  oldPrice: nullish(z.string().trim().max(40)),
  discount: nullish(z.string().trim().max(40)),
  badge: nullish(z.string().trim().max(40)),
  imageUrl: nullableSafeUrl,
  startDate: dateValue,
  endDate: dateValue,
  startTime: nullish(hhmm),
  endTime: nullish(hhmm),
  duration: nullish(z.number().int().min(4).max(600)), // segundos en carrusel
  priority: nullish(z.number().int().min(0).max(99)),
  order: nullish(order),
  active: nullish(z.boolean()),
})

/** Coherencia fechas/horas (con guards para updates parciales) */
function promotionCoherence(ctx: z.RefinementCtx, v: Record<string, unknown>): void {
  const { startDate, endDate, startTime, endTime } = v as {
    startDate?: string | Date | null
    endDate?: string | Date | null
    startTime?: string | null
    endTime?: string | null
  }
  const s = epochOf(startDate)
  const e = epochOf(endDate)
  if (s !== null && e !== null && s > e) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "startDate no puede ser posterior a endDate" })
  }
  if (startTime && endTime && startTime === endTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "startTime y endTime no pueden ser iguales" })
  }
}

export const promotionCreate = promotionShape.superRefine((v, ctx) => promotionCoherence(ctx, v))

export const promotionUpdate = promotionShape.partial().superRefine((v, ctx) => promotionCoherence(ctx, v))

// ---------- Dishes (sugerencias del día) ----------

export const dishCreate = z.object({
  name,
  description,
  price: nullish(z.string().trim().max(40)),
  imageUrl: nullableSafeUrl,
  ingredients: nullish(z.string().trim().max(500)),
  tag: nullish(z.string().trim().max(40)),
  nutrition: nullish(z.string().trim().max(200)),
  dayOfWeek: nullish(z.number().int().min(0).max(6)),
  date: dateValue,
  order: nullish(order),
  active: nullish(z.boolean()),
})

export const dishUpdate = dishCreate.partial()

// ---------- Schedules ----------

export const scheduleCreate = z
  .object({
    name,
    startTime: hhmm, // requerido y válido
    endTime: hhmm,
    dayOfWeek: nullish(z.number().int().min(0).max(6)),
    icon: nullish(z.string().trim().max(30)),
    color: nullish(hexColor),
    order: nullish(order),
    active: nullish(z.boolean()),
  })
  .refine((s) => s.startTime !== s.endTime, {
    message: "startTime y endTime no pueden ser iguales (usa overnight: fin < inicio)",
    path: ["endTime"],
  })
// overnight permitido: endTime < startTime cruza medianoche

export const scheduleUpdate = z
  .object({
    name,
    startTime: hhmm,
    endTime: hhmm,
    dayOfWeek: nullish(z.number().int().min(0).max(6)),
    icon: nullish(z.string().trim().max(30)),
    color: nullish(hexColor),
    order: nullish(order),
    active: nullish(z.boolean()),
  })
  .partial()
  .refine((s) => !s.startTime || !s.endTime || s.startTime !== s.endTime, {
    message: "startTime y endTime no pueden ser iguales",
    path: ["endTime"],
  })

// ---------- Socials ----------

const SOCIAL_NETWORKS = ["FACEBOOK", "INSTAGRAM", "WHATSAPP", "TIKTOK", "YOUTUBE", "TELEGRAM", "X"] as const

export const socialCreate = z.object({
  network: z.enum(SOCIAL_NETWORKS),
  username: nullish(z.string().trim().max(80)),
  url: nullableSafeUrl,
  color: nullish(hexColor),
  order: nullish(order),
  active: nullish(z.boolean()),
})

export const socialUpdate = socialCreate.partial()

// ---------- Ticker ----------

export const tickerCreate = z.object({
  text: text200,
  order: nullish(order),
  active: nullish(z.boolean()),
})

export const tickerUpdate = tickerCreate.partial()

// ---------- Screens ----------

export const screenCreate = z.object({
  code: screenCode,
  name,
  location: nullish(z.string().trim().max(120)),
  notes: nullish(z.string().trim().max(300)),
  active: nullish(z.boolean()),
})

export const screenUpdate = z.object({
  name,
  location: nullish(z.string().trim().max(120)),
  notes: nullish(z.string().trim().max(300)),
  active: nullish(z.boolean()),
  audioDeviceId: nullish(z.string().max(128)),
})

// ---------- Users (FASE 17 adelanta política de contraseña) ----------

export const PASSWORD_POLICY = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres")
  .max(128, "Contraseña demasiado larga")
  .regex(/[a-z]/, "Debe incluir una minúscula")
  .regex(/[A-Z]/, "Debe incluir una mayúscula")
  .regex(/\d/, "Debe incluir un número")

export const emailSchema = z.string().trim().toLowerCase().email("Email inválido").max(190)

export const userCreate = z.object({
  email: emailSchema,
  name,
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
  active: nullish(z.boolean()),
  password: PASSWORD_POLICY,
})

export const userUpdate = z.object({
  email: emailSchema,
  name,
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
  active: nullish(z.boolean()),
  password: PASSWORD_POLICY.optional(), // solo si se cambia
}).partial()

// ---------- Helper de uso en rutas ----------

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string }

/** Valida datos ya-normalizados (salida de pickFields) contra un esquema. */
export function validateData<S extends z.ZodType>(schema: S, data: unknown): ValidationResult<z.output<S>> {
  const res = schema.safeParse(data)
  if (res.success) return { ok: true, data: res.data }
  const first = res.error.issues[0]
  const field = first?.path?.join(".") ?? undefined
  return {
    ok: false,
    error: first ? `${field ? `«${field}» ` : ""}${first.message}` : "Datos inválidos",
    field,
  }
}
