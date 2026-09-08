/**
 * Validación centralizada de variables de entorno (Zod).
 *
 * Reglas de producción (misión FASE 1):
 *  - NUNCA usar secretos hardcodeados ni fallbacks conocidos.
 *  - En producción, si falta AUTH_SECRET / REALTIME_TOKEN / DATABASE_URL →
 *    fallo de startup (ver src/instrumentation.ts).
 *  - Valores placeholder del .env.example se rechazan explícitamente.
 *
 * La validación es PEREZOSA (en el primer acceso) para no romper `next build`
 * (que importa módulos sin ejecutar handlers). El arranque real del servidor
 * valida al inicio vía instrumentation.ts.
 */
import { z } from "zod"

/** Placeholders/valores conocidos prohibidos como secretos */
const FORBIDDEN_SECRETS = new Set([
  "signage-dev-secret-change-me",
  "signage-rt-internal-token",
  "cambiar-por-un-secreto-largo-y-aleatorio",
  "cambiar-por-otro-secreto-aleatorio",
  "changeme",
  "change-me",
  "secret",
  "password",
  "admin123",
])

function secretTooShort(len: number): string {
  return `debe tener al menos ${len} caracteres (usa: openssl rand -hex 24)`
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ---- Obligatorias (secretos / datos) ----
  AUTH_SECRET: z
    .string()
    .min(24, { message: secretTooShort(24) })
    .refine((v) => !FORBIDDEN_SECRETS.has(v.toLowerCase()), {
      message: "AUTH_SECRET es un placeholder conocido — genera uno real (openssl rand -hex 24)",
    }),
  REALTIME_TOKEN: z
    .string()
    .min(16, { message: secretTooShort(16) })
    .refine((v) => !FORBIDDEN_SECRETS.has(v.toLowerCase()), {
      message: "REALTIME_TOKEN es un placeholder conocido — genera uno real (openssl rand -hex 16)",
    }),
  DATABASE_URL: z.string().min(1, { message: "requerida (SQLite, p.ej. file:../db/custom.db)" }),

  // ---- Opcionales con defaults (no secretos) ----
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TIMEZONE: z.string().min(1).optional(), // si no está, se usa Settings.timezone

  // Almacenamiento separado (FASE 11 — defaults portables, se usan a partir de esa fase)
  MEDIA_DIR: z.string().min(1).optional(),
  BACKUP_DIR: z.string().min(1).optional(),
  LOG_DIR: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).optional(),

  // Streaming (los lee el stream-service; documentados aquí como fuente única)
  RTMP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HTTP_FLV_PORT: z.coerce.number().int().min(1).max(65535).optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

/** Formatea los errores de Zod en mensajes legibles */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join(".") || "(raíz)"
      return `  · ${path}: ${i.message}`
    })
    .join("\n")
}

/**
 * Valida el entorno y devuelve el objeto tipado (memoizado).
 * @throws Error con mensaje claro si el entorno es inválido.
 */
export function getEnv(): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const isProd = process.env.NODE_ENV === "production"
    const lines = formatIssues(parsed.error)
    throw new Error(
      `${isProd ? "✗ ENTORNO DE PRODUCCIÓN INVÁLIDO — el servidor NO puede arrancar" : "✗ Variables de entorno inválidas (copia .env.example a .env y complétalo)"}:\n${lines}`
    )
  }
  cached = parsed.data
  return cached
}

/**
 * Verificación sin throw (para instrumentation / health).
 * Devuelve null si todo está bien, o el mensaje de error.
 */
export function envError(): string | null {
  try {
    getEnv()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** ¿Estamos en producción? */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

/** Solo para tests: invalida la cache para re-validar tras cambiar process.env */
export function __resetEnvForTests(): void {
  cached = null
}
