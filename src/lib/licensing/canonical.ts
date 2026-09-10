/**
 * ViewLBA — Canonicalización de payloads de licencia.
 *
 * REGLA CRÍTICA: la firma NUNCA se calcula sobre "cualquier JSON" — se firma
 * la FORMA CANÓNICA determinista del payload (sin "signature"):
 *   1. Claves de objeto ordenadas alfabéticamente (recursivo).
 *   2. Sin espacios ni adornos (JSON.stringify plano).
 *   3. Arrays conservan su orden (posición significativa).
 *   4. Números/strings/booleans/null tal cual (sin coerción).
 *
 * Así el generador y el verificador producen EXACTAMENTE los mismos bytes
 * aunque el JSON se haya re-serializado con otro orden de claves.
 */

/** Elimina "signature" (y claves de metadatos prohibidos) de una licencia. */
export function stripSignature(obj: Record<string, unknown>): Record<string, unknown> {
  const { signature, ...rest } = obj
  return rest
}

/** Ordena recursivamente las claves de un valor JSON. */
function sortKeysDeep(value: unknown): unknown {
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
 * Serializa el payload de licencia en su forma canónica.
 * @param payload objeto SIN "signature" (usar stripSignature si viene firmado)
 * @returns string determinista (bytes firmables/verificables)
 */
export function canonicalizeLicensePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(payload))
}
