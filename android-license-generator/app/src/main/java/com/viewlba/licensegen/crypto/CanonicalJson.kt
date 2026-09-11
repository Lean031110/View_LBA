package com.viewlba.licensegen.crypto

/**
 * Serialización JSON CANÓNICA determinista — espejo EXACTO de
 * src/lib/licensing/canonical.ts (JSON.stringify(sortKeysDeep(x))):
 *   1. Claves de objeto ordenadas alfabéticamente (recursivo).
 *   2. Sin espacios ni adornos.
 *   3. Arrays conservan su orden.
 *   4. Enteros/strings/booleans/null sin coerción (nada de flotantes).
 *
 * El generador firma los bytes de esta serialización y el servidor
 * (TypeScript) verifica sobre los mismos bytes → compatibilidad garantizada
 * por vectores dorados (CrossCompatTest).
 */
object CanonicalJson {

    fun serialize(value: Any?): String {
        val sb = StringBuilder()
        writeValue(sb, value)
        return sb.toString()
    }

    private fun writeValue(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (v) "true" else "false")
            is Int -> sb.append(v.toString())
            is Long -> sb.append(v.toString())
            is String -> writeString(sb, v)
            is Map<*, *> -> {
                sb.append('{')
                val keys = v.keys.map { it.toString() }.sorted()
                for ((i, k) in keys.withIndex()) {
                    if (i > 0) sb.append(',')
                    writeString(sb, k)
                    sb.append(':')
                    writeValue(sb, v[k])
                }
                sb.append('}')
            }
            is List<*> -> {
                sb.append('[')
                for ((i, item) in v.withIndex()) {
                    if (i > 0) sb.append(',')
                    writeValue(sb, item)
                }
                sb.append(']')
            }
            else -> throw IllegalArgumentException("Tipo no canónico: ${v?.javaClass?.name}")
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
    }
}
