package com.viewlba.licensegen

import com.viewlba.licensegen.core.IssueOptions
import com.viewlba.licensegen.core.RequestPayload
import com.viewlba.licensegen.core.TokenIssuer
import com.viewlba.licensegen.crypto.Base32
import com.viewlba.licensegen.crypto.CanonicalJson
import com.viewlba.licensegen.crypto.Crc32
import com.viewlba.licensegen.crypto.CryptoBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * VECTORES DORADOS — compatibilidad TypeScript (servidor) ↔ Kotlin (Android).
 *
 * Los valores esperados los genera scripts/gen-golden-vectors.ts (repo raíz)
 * con el MISMO código del servidor. Si este test falla, el generador Android
 * y el servidor ViewLBA han divergido en algún byte.
 */
class CrossCompatTest {

    // ==== CANONICAL1 (payload de token con claves barajadas) ====
    private val canonical1 =
        """{"customerName":"Lo D'Leo","diskId":"DSK-A5ED-432A-37DD","durationDays":30,"expiresAt":1759660800000,"features":{"users.management":true},"installationId":"VWLB-0094-6114-A3A4-8905","issuedAt":1757068800000,"licenseId":"VLBA-aaaaaaaaaaaa","nonce":"0123456789abcdef","plan":"monthly","product":"ViewLBA-Server","startsAt":1757068800000,"v":2}"""

    // ==== BASE32 ====
    private val base32Foobar = "MZXW6YTBOI"
    private val base32Bytes = "AAAQEAYEAUDAOCAJBIFQYDIOB4"

    // ==== CRC32 ====
    private val crc32_123456789 = 3421780262L
    private val crc32Foobar = 2666930069L

    // ==== Claves fijas (seeds) ====
    private val edSeedB64 = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8"
    private val edPubB64 = "IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY"
    private val xSeedB64 = "_ty6mHZUMhD-3LqYdlQyEP7cuph2VDIQ_ty6mHZUMhA"
    private val xPubB64 = "0bFTxJZMaRGAXldvLCYe3U3DXU15r_7StZiSggH3eFM"

    // ==== Token VLBA2 emitido por el TS con el payload/seed fijos ====
    private val vlba2Token =
        "VLBA2-KZKD-EAQB-KV5S-EY3V-ON2G-63LF-OJHG-C3LF-EI5C-ETDP-EBCC-OTDF-N4RC-YITE-NFZW-WSLE-EI5C-ERCT-JMWU-CNKF-IQWT-IMZS-IEWT-GN2E-IQRC-YITE-OVZG-C5DJ-N5XE-IYLZ-OMRD-UMZQ-FQRG-K6DQ-NFZG-K42B-OQRD-UMJX-GU4T-MNRQ-HAYD-AMBQ-GAWC-EZTF-MF2H-K4TF-OMRD-U6ZC-OVZW-K4TT-FZWW-C3TB-M5SW-2ZLO-OQRD-U5DS-OVSX-2LBC-NFXH-G5DB-NRWG-C5DJ-N5XE-SZBC-HIRF-MV2M-IIWT-AMBZ-GQWT-MMJR-GQWU-CM2B-GQWT-QOJQ-GURC-YITJ-ONZX-KZLE-IF2C-EORR-G42T-OMBW-HA4D-AMBQ-GAYC-YITM-NFRW-K3TT-MVEW-IIR2-EJLE-YQSB-FVQW-CYLB-MFQW-CYLB-MFQW-CIRM-EJXG-63TD-MURD-UIRQ-GEZD-GNBV-GY3T-QOLB-MJRW-IZLG-EIWC-E4DM-MFXC-EORC-NVXW-45DI-NR4S-ELBC-OBZG-6ZDV-MN2C-EORC-KZUW-K52M-IJAS-2U3F-OJ3G-K4RC-FQRH-G5DB-OJ2H-GQLU-EI5D-CNZV-G4YD-MOBY-GAYD-AMBQ-FQRH-MIR2-GJ6S-7OXQ-4V72-SE2O-YDYC-P3Z4-TAIN-56WF-ZHEJ-2BDB-ARVD-IWFV-MQE3-XWVE-VFXB-7PH4-VIGV-GTKY-6LLH-A5JV-ZS2I-YDYP-LQ6B-LCBI-G7D7-UW77-AXVI-B7LS"

    // ==== Código VLREQ2 sellado por el TS hacia xPub fijo ====
    private val vlreq2Code =
        "VLREQ2-KZJD-EAQO-VRBL-JD2I-M3JY-TFTY-2YBX-OQFS-SHH3-57J6-6B7E-JF23-KJ67-R5AO-BLX4-EOKS-OZLY-7WLA-JUVE-IAGN-4I4A-ASPK-NOSE-UJ6T-H2OW-QDWY-S66U-ZBW4-7I7E-3FHR-FWUN-4AW4-S75H-YG7X-N4Z7-FGIV-ZU2R-ECSG-JOGP-BWK3-56WG-DEHM-6KVB-KQJV-S35W-2DD2-NO4V-FKEB-L2KM-HAMW-TYO3-ZEXY-DYEY-HQJ2-OKGU-T5XC-Y2DY-Z7XS-4XUS-XI3Z-CG4C-TIV6-QGWP-4J3I-X4RQ-LDZ2-J7EI-LXGU-L4GV-IBVZ-UBR3-QWTW-N45G-37TI-ERWB-6JN2-F4YB-HLO7-IFRX-BQJ2-TZWX-MILE-K4WI-HC2F-IKR5-FA2B-DORB-ZS2K-RBDC-2XBY-3L2Q-J2TR-3V2O-556C-4FDX-OV5O-WRSO-WIOJ-GZYR-O4R2-DOZC-LU7X-ZICW-MTA"

    // ------------------------------------------------------------------

    @Test
    fun `canonical json - claves ordenadas y sin espacios (byte a byte)`() {
        val payload = linkedMapOf<String, Any>(
            "v" to 2,
            "licenseId" to "VLBA-aaaaaaaaaaaa",
            "customerName" to "Lo D'Leo",
            "plan" to "monthly",
            "durationDays" to 30,
            "product" to "ViewLBA-Server",
            "issuedAt" to 1757068800000L,
            "startsAt" to 1757068800000L,
            "expiresAt" to 1759660800000L,
            "installationId" to "VWLB-0094-6114-A3A4-8905",
            "diskId" to "DSK-A5ED-432A-37DD",
            "features" to linkedMapOf("users.management" to true),
            "nonce" to "0123456789abcdef",
        )
        assertEquals(canonical1, CanonicalJson.serialize(payload))
    }

    @Test
    fun `base32 - vector RFC 4648 foobar`() {
        assertEquals(base32Foobar, Base32.encode("foobar".toByteArray()))
        assertTrue("MZXW6YTBOI".let { Base32.decodeStrict(it)!!.contentEquals("foobar".toByteArray()) })
    }

    @Test
    fun `base32 - bytes 015`() {
        assertEquals(base32Bytes, Base32.encode((0 until 16).map { it.toByte() }.toByteArray()))
    }

    @Test
    fun `crc32 - vectores IEEE`() {
        assertEquals(crc32_123456789, Crc32.of("123456789".toByteArray()))
        assertEquals(crc32Foobar, Crc32.of("foobar".toByteArray()))
    }

    @Test
    fun `base64url - ida y vuelta de las claves fijas`() {
        val edSeed = CryptoBox.base64UrlDecodeStrict(edSeedB64)!!
        assertEquals(32, edSeed.size)
        assertEquals(edSeedB64, CryptoBox.base64UrlEncode(edSeed))
        assertEquals(edPubB64, CryptoBox.base64UrlEncode(CryptoBox.ed25519PublicKey(edSeed)))

        val xSeed = CryptoBox.base64UrlDecodeStrict(xSeedB64)!!
        assertEquals(32, xSeed.size)
        assertEquals(xPubB64, CryptoBox.base64UrlEncode(CryptoBox.x25519PublicKey(xSeed)))
    }

    @Test
    fun `VLBA2 - el generador Kotlin reproduce EXACTAMENTE el token del TS`() {
        val edSeed = CryptoBox.base64UrlDecodeStrict(edSeedB64)!!
        val payload = TokenIssuer.buildPayload(
            licenseId = "VLBA-aaaaaaaaaaaa",
            customerName = "Lo D'Leo",
            plan = "monthly",
            durationDays = 30,
            issuedAt = 1757068800000L,
            startsAt = 1757068800000L,
            installationId = "VWLB-0094-6114-A3A4-8905",
            diskId = "DSK-A5ED-432A-37DD",
            features = linkedMapOf("users.management" to true),
            nonce = "0123456789abcdef",
        )
        val token = TokenIssuer.issue(payload, edSeed)
        assertEquals(vlba2Token, token)
    }

    @Test
    fun `VLREQ2 - el generador Kotlin abre EXACTAMENTE el código sellado por el TS`() {
        val xPriv = CryptoBox.base64UrlDecodeStrict(xSeedB64)!!
        val now = 1757068800000L
        val opened = com.viewlba.licensegen.core.RequestOpener.open(vlreq2Code, xPriv, now)
        assertEquals("Lo D'Leo", opened.customerName)
        assertEquals("VWLB-0094-6114-A3A4-8905", opened.installationId)
        assertEquals("DSK-A5ED-432A-37DD", opened.diskId)
        assertEquals(now, opened.requestedAt)
        assertEquals("0123456789abcdef", opened.nonce)
        assertTrue(opened.requestHash.matches(Regex("^[0-9a-f]{64}$")))
    }

    @Test
    fun `VLREQ2 - Kotlin también SELLA hacia la pública TS (roundtrip completo bidireccional)`() {
        // sellar en Kotlin (ECDH efímero) y abrir en Kotlin con la privada TS
        val xPriv = CryptoBox.base64UrlDecodeStrict(xSeedB64)!!
        val xPub = CryptoBox.x25519PublicKey(xPriv)

        // payload canónico de solicitud (mismo formato que el servidor TS)
        val payload = linkedMapOf<String, Any>(
            "v" to 2,
            "product" to "ViewLBA-Server",
            "customerName" to "Lo D'Leo",
            "installationId" to "VWLB-0094-6114-A3A4-8905",
            "diskId" to "DSK-A5ED-432A-37DD",
            "nonce" to "0123456789abcdef",
            "requestedAt" to 1757068800000L,
        )
        val json = CanonicalJson.serialize(payload)

        // sealed box manual (espejo de sealRequestPayload del TS)
        val ephPriv = CryptoBox.newX25519PrivateKey()
        val ephPub = CryptoBox.x25519PublicKey(ephPriv)
        val shared = ByteArray(32)
        org.bouncycastle.math.ec.rfc7748.X25519.calculateAgreement(ephPriv, 0, xPub, 0, shared, 0)
        val key = CryptoBox.hkdfSha256(shared, ephPub, "viewlba-req-v2".toByteArray(), 32)
        val enc = CryptoBox.aesGcmEncrypt(key, json.toByteArray())

        val frame = com.viewlba.licensegen.codec.TokenCodec.buildRequestFrame(ephPub, enc.iv, enc.ciphertext)
        val code = com.viewlba.licensegen.codec.TokenCodec.encodeRequestString(frame)

        val opened = com.viewlba.licensegen.core.RequestOpener.open(code, xPriv, 1757068800000L)
        assertEquals("Lo D'Leo", opened.customerName)
    }

    @Test
    fun `VLBA2 - decodificación del token dorado con estructura verificada`() {
        val frame = com.viewlba.licensegen.codec.TokenCodec.parseTokenFrame(
            Base32.decodeStrict(vlba2Token.removePrefix("VLBA2-").replace("-", ""))!!
        )
        // la firma verifica con la pública derivada del seed dorado
        val edSeed = CryptoBox.base64UrlDecodeStrict(edSeedB64)!!
        assertTrue(CryptoBox.ed25519Verify(CryptoBox.ed25519PublicKey(edSeed), frame.payloadBytes, frame.signature))
        // el payload canónico coincide byte a byte con el esperado del TS
        assertEquals(canonical1, String(frame.payloadBytes, Charsets.UTF_8))
    }

    @Test
    fun `estabilidad - issueOptions y requestPayload no rompen invariantes`() {
        val opts = IssueOptions(IssueOptions.Plan.ANNUAL, 365, 1757068800000L)
        assertEquals("annual", opts.plan.key)
        assertEquals(365, opts.durationDays)
        val req = RequestPayload(2, "ViewLBA-Server", "X", "VWLB-0094-6114-A3A4-8905", "DSK-A5ED-432A-37DD", "0123456789abcdef", 1757068800000L, "hash")
        assertNotEquals(req.requestedAt, 0L)
    }

    @Test
    fun `base32 - degradación controlada`() {
        assertNull(Base32.decodeStrict("A"))      // mod 8 = 1
        assertNull(Base32.decodeStrict("AAA"))    // mod 8 = 3
        assertNull(Base32.decodeStrict("ABCDEF")) // mod 8 = 6
        assertNull(Base32.decodeStrict("AB"))     // bits basura
        assertNull(Base32.decodeStrict("0123456"))// dígitos fuera de alfabeto
        assertNull(Base32.decodeStrict(""))
    }
}
