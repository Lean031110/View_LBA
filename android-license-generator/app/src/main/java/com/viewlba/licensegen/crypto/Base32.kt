package com.viewlba.licensegen.crypto

/**
 * Base32 RFC 4648 SIN padding — alfabeto A-Z/2-7 (sin guiones: los
 * separadores "-" del formato externo son inequívocos).
 *
 * Espejo EXACTO de src/lib/licensing/codec.ts (verificado con vectores
 * dorados en los tests JVM).
 */
object Base32 {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private val DECODE = IntArray(128) { -1 }.also { d ->
        for (i in ALPHABET.indices) d[ALPHABET[i].code] = i
    }

    /** Codifica a Base32 sin padding. */
    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 8 + 4) / 5)
        var bits = 0
        var value = 0
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) out.append(ALPHABET[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    /**
     * Decodifica Base32 ESTRICTO (mayúsculas, sin padding, sin guiones).
     * @return null si hay caracteres inválidos, longitud imposible o bits
     *         basura al final (alterado/truncado).
     */
    fun decodeStrict(s: String): ByteArray? {
        if (s.isEmpty()) return null
        val out = ArrayList<Byte>((s.length * 5 + 7) / 8)
        var bits = 0
        var value = 0
        for (ch in s) {
            val code = ch.code
            val v = if (code in 0 until 128) DECODE[code] else -1
            if (v < 0) return null
            value = (value shl 5) or v
            bits += 5
            if (bits >= 8) {
                out.add(((value ushr (bits - 8)) and 0xff).toByte())
                bits -= 8
            }
        }
        // bits sobrantes deben ser CERO en una codificación bien formada
        if (bits > 0 && (value and ((1 shl bits) - 1)) != 0) return null
        // longitudes válidas mod 8: 0,2,4,5,7
        val rem = s.length % 8
        if (rem == 1 || rem == 3 || rem == 6) return null
        return out.toByteArray()
    }
}
