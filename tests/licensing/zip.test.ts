/**
 * Tests: ZIP mínimo de licencias (sección 27 — importación corrupta).
 * Roundtrip escritura→lectura, DEFLATE, CRC, corrupción.
 */
import { describe, expect, it } from "bun:test"
import { buildZip, readZip, findZipEntry, crc32 } from "@/lib/licensing/zip"
import { deflateRawSync } from "node:zlib"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("buildZip / readZip (STORE)", () => {
  it("roundtrip: escribe 2 entradas y las lee con CRC verificado", () => {
    const license = Buffer.from(JSON.stringify({ licenseId: "VLBA-test" }), "utf8")
    const readme = Buffer.from("ViewLBA — Licencia", "utf8")
    const zip = buildZip([
      { name: "license.json", data: license },
      { name: "README.txt", data: readme },
    ])
    const entries = readZip(zip)
    expect(entries).toHaveLength(2)
    expect(entries[0].name).toBe("license.json")
    expect(entries[0].data.equals(license)).toBe(true)
    expect(entries[1].name).toBe("README.txt")
    expect(entries[1].data.equals(readme)).toBe(true)
  })

  it("el ZIP producido lo abre unzip del sistema (compatibilidad real)", () => {
    const hasUnzip = (() => {
      try {
        execFileSync("unzip", ["-v"], { stdio: "ignore" })
        return true
      } catch {
        return false
      }
    })()
    if (!hasUnzip) return // Windows/sin unzip: el roundtrip interno basta
    const zip = buildZip([
      { name: "license.json", data: Buffer.from('{"ok":true}', "utf8") },
      { name: "README.txt", data: Buffer.from("hola", "utf8") },
    ])
    const tmp = join(tmpdir(), `viewlba-zip-compat-${Date.now()}.zip`)
    writeFileSync(tmp, zip)
    try {
      const out = execFileSync("unzip", ["-t", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      expect(out).toContain("No errors detected")
    } finally {
      rmSync(tmp, { force: true })
    }
  })

  it("nombres UTF-8 con acentos se conservan", () => {
    const zip = buildZip([{ name: "licencia-ñ.txt", data: Buffer.from("acentos: áéíóú", "utf8") }])
    const entries = readZip(zip)
    expect(entries[0].name).toBe("licencia-ñ.txt")
    expect(entries[0].data.toString("utf8")).toBe("acentos: áéíóú")
  })
})

describe("readZip — robustez ante corrupción (anti-manipulación)", () => {
  it("buffer no-ZIP → error claro", () => {
    expect(() => readZip(Buffer.from("esto no es un zip suficientemente largo"))).toThrow(/directorio central/i)
    expect(() => readZip(Buffer.from("corto"))).toThrow(/truncado/i)
  })

  it("ZIP truncado → error", () => {
    const zip = buildZip([{ name: "license.json", data: Buffer.from("{}") }])
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow()
  })

  it("entrada con datos manipulados (CRC inválido) → error", () => {
    const data = Buffer.from('{"licenseId":"VLBA-original-aaaaaaaaaaaa"}')
    const name = "license.json"
    const zip = buildZip([{ name, data }])
    // corromper un byte del ÁREA DE DATOS (local header 30 + nombre 14)
    const dataOffset = 30 + name.length
    zip[dataOffset] ^= 0xff
    expect(() => readZip(zip)).toThrow(/CRC32 inválido/)
  })

  it("ZIP vacío (0 entradas) → error de entrada", () => {
    expect(() => buildZip([])).toThrow(/sin entradas/i)
  })
})

describe("readZip — DEFLATE (compatibilidad con zips de terceros)", () => {
  it("lee entradas comprimidas con DEFLATE (método 8)", () => {
    const raw = Buffer.from(JSON.stringify({ plan: "annual", customerName: "Leandro Bueno", padding: "x".repeat(500) }), "utf8")
    const compressed = deflateRawSync(raw)

    // Construcción manual de un ZIP con método DEFLATE (1 entrada)
    const name = Buffer.from("license.json", "utf8")
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8) // DEFLATE
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12) // fecha cualquiera
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10) // DEFLATE
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 42) // offset local
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length + name.length, 12)
    eocd.writeUInt32LE(30 + name.length + compressed.length, 16)
    const zip = Buffer.concat([local, name, compressed, central, name, eocd])

    const entries = readZip(zip)
    expect(entries[0].method).toBe(8)
    expect(entries[0].data.equals(raw)).toBe(true)
  })
})

describe("findZipEntry", () => {
  it("encuentra por nombre exacto y tolera subcarpetas", () => {
    const entries = [
      { name: "carpeta/license.json", data: Buffer.from("1"), method: 0 },
      { name: "README.txt", data: Buffer.from("2"), method: 0 },
    ]
    expect(findZipEntry(entries, "license.json")?.data.toString()).toBe("1")
    expect(findZipEntry(entries, "README.txt")?.data.toString()).toBe("2")
    expect(findZipEntry(entries, "no-existe.txt")).toBeNull()
  })
})

describe("crc32", () => {
  it("valores conocidos (CRC-32/ISO-HDLC de '123456789' = 0xCBF43926)", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926)
  })
})
