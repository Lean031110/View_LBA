package com.viewlba.licensegen.crypto

/**
 * CRC32 IEEE (mismo polinomio/resultado que el códec TypeScript del servidor).
 */
object Crc32 {
    private val TABLE = IntArray(256).also { table ->
        for (n in 0 until 256) {
            var c = n
            for (k in 0 until 8) {
                c = if (c and 1 == 1) 0xedb88320.toInt() xor (c ushr 1) else c ushr 1
            }
            table[n] = c
        }
    }

    /** CRC32 IEEE de un array de bytes (uint32 como Long sin signo implícito). */
    fun of(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size): Long {
        var c = -1 // 0xffffffff
        for (i in offset until offset + length) {
            c = TABLE[(c xor bytes[i].toInt()) and 0xff] xor (c ushr 8)
        }
        return (c.toLong() xor 0xffffffffL) and 0xffffffffL
    }
}
