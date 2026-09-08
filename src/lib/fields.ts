/**
 * Validación y normalización de campos del body (sin dependencias).
 *
 * Especificación de tipos:
 *   s  = string requerido        s? = string nullable
 *   n  = number                  n? = number nullable
 *   b  = boolean                 d? = fecha nullable
 *
 * Se acepta `Record<string, string>` para que las rutas API puedan definir
 * specs como objetos literales sin anotaciones; los valores desconocidos
 * se descartan en tiempo de ejecución (defensa en profundidad).
 */
import type { NextRequest } from "next/server"

const FIELD_TYPES = new Set(["s", "s?", "n", "n?", "b", "d?"])
type FieldType = "s" | "s?" | "n" | "n?" | "b" | "d?"

/** Filtra y normaliza los campos presentes en el body según el spec. */
export function pickFields(body: Record<string, unknown>, spec: Record<string, string>) {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(spec)) {
    if (!(key in body) || !FIELD_TYPES.has(raw)) continue
    const v = body[key]
    switch (raw as FieldType) {
      case "s":
        out[key] = v == null ? "" : String(v)
        break
      case "s?":
        out[key] = v == null || v === "" ? null : String(v)
        break
      case "n":
        out[key] = Number.isFinite(Number(v)) ? Number(v) : 0
        break
      case "n?":
        out[key] = v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null
        break
      case "b":
        out[key] = v === true || v === "true"
        break
      case "d?":
        out[key] = v ? new Date(String(v)) : null
        break
    }
  }
  return out
}

/** Lee el JSON del body de forma tolerante a errores. */
export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}
