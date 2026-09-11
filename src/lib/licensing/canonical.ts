/**
 * ViewLBA — Canonicalización de payloads (tokens y solicitudes).
 *
 * REGLA CRÍTICA: la firma Ed25519 del token VLBA2 cubre los bytes EXACTOS del
 * payload JSON tal como lo serializa el generador. Para que emisor (Android,
 * Kotlin) y verificador (servidor, TypeScript) produzcan EXACTAMENTE los
 * mismos bytes, el payload se serializa SIEMPRE en forma canónica:
 *   1. Claves de objeto ordenadas alfabéticamente (recursivo, orden UTF-16).
 *   2. Sin espacios ni adornos (JSON.stringify plano / serializador mínimo).
 *   3. Arrays conservan su orden (posición significativa).
 *   4. Números enteros, strings, booleans y null tal cual (sin coerción).
 *
 * El mismo algoritmo está implementado en el generador Android
 * (android-license-generator: CanonicalJson.kt) — AMBOS deben coincidir.
 */

/** Ordena recursivamente las claves de un valor JSON. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Serializa un payload en su forma canónica determinista.
 * @returns string (bytes firmables/sellables)
 */
export function canonicalize(payload: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(payload))
}
