/**
 * Parseo de archivos .env SIN depender de process.env (FASE 31, PASO 3-4).
 *
 * Problema que resuelve: dotenv (y la carga automática de Bun) NO sobrescribe
 * variables que ya existen en el entorno del proceso. Un shell con
 * `DATABASE_URL=...` exportada puede hacer que el .env local sea IGNORADO
 * silenciosamente. El instalador necesita leer el archivo como FUENTE DE
 * VERDAD para saber qué se SUPONE que debe aplicar, y compararlo con lo que
 * el entorno dice.
 *
 * Funciones PURAS (testeables sin proceso real).
 */
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

/** Pares clave/valor extraídos de un archivo .env (sin procesar más allá). */
export type EnvFileRecord = Record<string, string>

/**
 * Parsea el contenido de un .env.
 *  - ignora comentarios (#) y líneas vacías;
 *  - admite `KEY=value`, `KEY="value"`, `KEY='value'`, `export KEY=value`;
 *  - strip de comillas y espacios alrededor del valor;
 *  - las claves duplicadas: gana la ÚLTIMA aparición (comportamiento dotenv).
 */
export function parseEnvFile(content: string): EnvFileRecord {
  const out: EnvFileRecord = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    // Comentario en línea estilo dotenv — SOLO si el valor no está entrecomillado
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #")
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    // Comillas: quitar solo si envuelven TODO el valor
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Lee y parsea un archivo .env del disco (null si no existe). */
export function readEnvFile(path: string): EnvFileRecord | null {
  try {
    if (!existsSync(path)) return null
    return parseEnvFile(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * Normaliza una URL SQLite `file:...` a ruta absoluta comparable.
 *  - `file:/abs/path` → `/abs/path`
 *  - `file:rel/path`  → resuelta contra `relativeTo` (CWD por defecto)
 * Devuelve null si la URL no es file: de SQLite.
 */
export function sqlitePathFromUrl(url: string, relativeTo: string = process.cwd()): string | null {
  if (!url.startsWith("file:")) return null
  const raw = url.slice(5)
  const isAbs = raw.startsWith("/") || /^[A-Za-z]:[/\\]/.test(raw)
  const normalized = raw.replace(/\\/g, "/")
  const abs = isAbs ? normalized : resolve(relativeTo, normalized).replace(/\\/g, "/")
  return abs.replace(/\/+$/, "") || null
}

/**
 * Compara dos rutas SQLite con tolerancia (separadores, trailing slash,
 * rutas relativas resueltas). Case-insensitive SOLO en rutas estilo Windows.
 */
export function sqlitePathsMatch(a: string, b: string, relativeTo: string = process.cwd()): boolean {
  const pa = sqlitePathFromUrl(a, relativeTo)
  const pb = sqlitePathFromUrl(b, relativeTo)
  if (pa === null || pb === null) return false
  if (pa === pb) return true
  if (/^[A-Za-z]:\//.test(pa) && /^[A-Za-z]:\//.test(pb)) return pa.toLowerCase() === pb.toLowerCase()
  return false
}

/**
 * Extrae la ruta del datasource de la salida de la CLI de Prisma.
 * Línea esperada: `Datasource "db": SQLite database "custom.db" at "file:/abs/path"`
 * Devuelve el valor `file:...` o null si no aparece.
 */
export function parseDatasourceUrl(prismaOutput: string): string | null {
  const m = /Datasource\s+"db":\s+SQLite database\s+"[^"]*"\s+at\s+"(file:[^"]+)"/.exec(prismaOutput)
  return m ? m[1] : null
}

/**
 * Resuelve el DATABASE_URL objetivo según la prioridad correcta:
 *   1. explicit (opción del instalador / flag)
 *   2. valor del archivo .env (fuente local de verdad)
 *   3. process.env (entorno heredado — puede estar contaminado)
 * Junto con la fuente elegida, para diagnóstico.
 */
export function resolveDatabaseTarget(
  explicit: string | undefined,
  fileEnv: EnvFileRecord | null
): { url: string; source: "explicit" | "env-file" | "process-env" } | null {
  if (explicit && explicit.trim()) return { url: explicit.trim(), source: "explicit" }
  const fromFile = fileEnv?.DATABASE_URL?.trim()
  if (fromFile) return { url: fromFile, source: "env-file" }
  const fromEnv = process.env.DATABASE_URL?.trim()
  if (fromEnv) return { url: fromEnv, source: "process-env" }
  return null
}

/**
 * Detecta contaminación del entorno: DATABASE_URL exportada externamente
 * que DIFIERE de la del .env local. Devuelve advertencia legible o null.
 */
export function detectEnvContamination(fileEnv: EnvFileRecord | null): string | null {
  const shellUrl = process.env.DATABASE_URL?.trim()
  const fileUrl = fileEnv?.DATABASE_URL?.trim()
  if (!shellUrl || !fileUrl) return null
  if (sqlitePathsMatch(shellUrl, fileUrl)) return null
  return (
    `El entorno del proceso tiene DATABASE_URL="${shellUrl}" exportada, que DIFIERE de la del ` +
    `.env ("${fileUrl}"). dotenv NO sobrescribe variables existentes: la del entorno GANARÍA ` +
    `en procesos hijos. El instalador aplicará explícitamente el objetivo seleccionado y ` +
    `verificará el datasource real antes de migrar.`
  )
}
