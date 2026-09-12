/**
 * TESTS — Lector ZIP del motor de temas (§11 path traversal, §12 bombas).
 *
 * Regla: TODO rechazo debe ser ThemeError tipado (REJECT SAFE, sin crash).
 */
import { describe, it, expect } from "bun:test"
import { readZip, writeZip, crc32Of, validateEntryName } from "@/lib/themes/zip"
import { ThemeError } from "@/lib/themes/types"
import { writeEvilZip, zeros, makePng } from "./helpers"

function expectReject(buf: Buffer, code: string, label: string) {
  try {
    readZip(buf)
    throw new Error(`DEBÍA RECHAZAR (${label})`)
  } catch (e) {
    expect(e instanceof ThemeError).toBe(true)
    expect((e as ThemeError).code).toBe(code)
  }
}

describe("ZIP reader — roundtrip válido", () => {
  it("escribe y lee un ZIP STORED con varias entradas (contenido íntegro)", () => {
    const png = makePng(64, 32)
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from("{\"a\":1}") },
      { name: "theme.json", data: Buffer.from("{\"b\":2}") },
      { name: "assets/bg.png", data: png },
    ])
    const entries = readZip(buf)
    expect(entries.length).toBe(3)
    const map = new Map(entries.map((e) => [e.name, e]))
    expect(map.get("manifest.json")!.read().toString()).toBe("{\"a\":1}")
    expect(map.get("assets/bg.png")!.read().length).toBe(png.length)
    expect(Buffer.compare(map.get("assets/bg.png")!.read(), png)).toBe(0)
  })

  it("CRC32 es el estándar PKZIP (vector '123456789' → 0xCBF43926)", () => {
    expect(crc32Of(Buffer.from("123456789"))).toBe(0xcbf43926)
  })

  it("el escritor es determinista (mismo input → mismo output)", () => {
    const files = [{ name: "a.json", data: Buffer.from("hola") }]
    expect(Buffer.compare(writeZip(files), writeZip(files))).toBe(0)
  })
})

describe("ZIP reader — estructura corrupta (fail-closed)", () => {
  it("buffer vacío / demasiado pequeño → not_zip", () => {
    expectReject(Buffer.alloc(0), "not_zip", "vacío")
    expectReject(Buffer.alloc(10), "not_zip", "10 bytes")
  })

  it("bytes aleatorios sin EOCD → not_zip", () => {
    const rnd = Buffer.alloc(1024)
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256)
    expectReject(rnd, "not_zip", "aleatorio")
  })

  it("EOCD con central directory fuera de rango → zip_corrupt", () => {
    const valid = writeZip([{ name: "a.json", data: Buffer.from("{}") }])
    // Mutar el offset del CD (EOCD+16) a un valor imposible
    const broken = Buffer.from(valid)
    broken.writeUInt32LE(valid.length + 5000, valid.length - 6)
    expectReject(broken, "zip_corrupt", "CD fuera de rango")
  })

  it("tamaño declarado ≠ contenido real → zip_corrupt", () => {
    const buf = writeEvilZip([{ name: "a.json", data: Buffer.from("{}"), lieUncompressed: 9999 }])
    // El presupuesto global pasa, pero al leer: length real ≠ declarada
    try {
      readZip(buf)
        .filter((e) => !e.isDirectory)
        .forEach((e) => e.read())
      throw new Error("DEBÍA RECHAZAR (tamaño mentiroso)")
    } catch (e) {
      expect(e instanceof ThemeError).toBe(true)
      expect((e as ThemeError).code).toBe("zip_corrupt")
    }
  })

  it("CRC mentiroso → zip_corrupt", () => {
    const buf = writeEvilZip([{ name: "manifest.json", data: Buffer.from("{}"), lieCrc: 0xdeadbeef }])
    try {
      readZip(buf).forEach((e) => e.read())
      throw new Error("DEBÍA RECHAZAR (CRC)")
    } catch (e) {
      expect(e instanceof ThemeError).toBe(true)
      expect((e as ThemeError).code).toBe("zip_corrupt")
    }
  })
})

describe("ZIP reader — §11 PATH TRAVERSAL (todos rechazados)", () => {
  const traversalNames = [
    "../../server.js",
    "../../../etc/passwd",
    "..\\..\\Windows\\System32\\evil.dll",
    "/etc/passwd",
    "C:\\Windows\\evil.ini",
    "assets/../../../evil.png",
    "assets/..",
    "..",
    "a/../../b.json",
    "assets/../../theme.json",
  ]

  for (const name of traversalNames) {
    it(`entrada '${name.replace(/\n/g, "")}' → rechazo tipado`, () => {
      const buf = writeEvilZip([{ name, data: Buffer.from("x") }])
      expectReject(buf, "traversal", name)
    })
  }

  it("validateEntryName: NUL, unicode, control, espacios → entry_name_invalid", () => {
    const badNames = ["evil\u0000.json", "cárcel.json", "evil\t.json", "a b.json", "evil\n.json"]
    for (const n of badNames) {
      try {
        validateEntryName(n)
        throw new Error(`DEBÍA RECHAZAR '${n.replace(/\n/g, "")}'`)
      } catch (e) {
        expect(e instanceof ThemeError).toBe(true)
        expect((e as ThemeError).code).toBe("entry_name_invalid")
      }
    }
  })

  it("validateEntryName: dispositivos Windows (CON/NUL/AUX/COM1) → rechazo", () => {
    for (const n of ["CON", "NUL.json", "COM1.png", "LPT9.txt"]) {
      try {
        validateEntryName(n)
        throw new Error("DEBÍA RECHAZAR dispositivo")
      } catch (e) {
        expect((e as ThemeError).code).toBe("entry_name_invalid")
      }
    }
  })

  it("ruta con profundidad excesiva → entry_name_invalid", () => {
    const deep = Array(8).fill("a").join("/") + "/x.json"
    try {
      validateEntryName(deep)
      throw new Error("DEBÍA RECHAZAR profundidad")
    } catch (e) {
      expect((e as ThemeError).code).toBe("entry_name_invalid")
    }
  })
})

describe("ZIP reader — §12 límites y bombas", () => {
  it("más de 200 entradas → too_many_entries", () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.json`, data: Buffer.from("{}") }))
    expectReject(writeZip(files), "too_many_entries", "201 entradas")
  })

  it("nombres duplicados exactos → duplicate", () => {
    const buf = writeEvilZip([
      { name: "manifest.json", data: Buffer.from("{}") },
      { name: "manifest.json", data: Buffer.from("{}") },
    ])
    expectReject(buf, "duplicate", "duplicado")
  })

  it("total descomprimido declarado > 120 MB → uncompressed_limit", () => {
    // 10 entradas que DECLARAN 13 MB cada una (comprimido real pequeño)
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `big${i}.bin`,
      data: Buffer.alloc(1024),
      lieUncompressed: 13 * 1024 * 1024,
    }))
    expectReject(writeEvilZip(entries), "uncompressed_limit", "presupuesto global")
  })

  it("ratio de compresión imposible (bomba) → bomb_suspected", () => {
    // 70 MB de zeros: DEFLATE los deja en ~70 KB (comprimido > umbral de
    // 64 KB) con ratio ~1000× — patrón inequívoco de ZIP bomb.
    const bomb = zeros(70 * 1024 * 1024)
    const { deflateRawSync } = require("node:zlib") as typeof import("node:zlib")
    const compressed = deflateRawSync(bomb)
    expect(compressed.length).toBeGreaterThan(64 * 1024) // garantiza que el chequeo aplica
    const buf = writeEvilZip([{ name: "bomb.bin", data: compressed, method: 8, lieUncompressed: bomb.length }])
    expectReject(buf, "bomb_suspected", "ratio ~1000×")
  })

  it("entrada cifrada (flag bit 0) → encrypted_entry", () => {
    const buf = writeEvilZip([{ name: "secret.json", data: Buffer.from("{}"), flags: 0x1 }])
    expectReject(buf, "encrypted_entry", "cifrada")
  })

  it("método de compresión no soportado → bad_compression", () => {
    const buf = writeEvilZip([{ name: "a.json", data: Buffer.from("{}"), method: 12 }])
    expectReject(buf, "bad_compression", "bzip2")
  })

  it("paquete > 50 MB → too_big", () => {
    const big = Buffer.concat([Buffer.alloc(50 * 1024 * 1024 + 100, 1)])
    expectReject(big, "too_big", "51 MB")
  })
})

describe("ZIP reader — symlinks y tipos de entrada (§10.8)", () => {
  const S_IFLNK = 0xa1ff // S_IFLNK | 0777
  const S_IFCHR = 0x21ff // character device
  const S_IFIFO = 0x11ff // FIFO

  for (const [label, attrs] of [
    ["symlink", S_IFLNK],
    ["char device", S_IFCHR],
    ["FIFO", S_IFIFO],
  ] as const) {
    it(`entrada tipo ${label} → symlink (rechazo)`, () => {
      const buf = writeEvilZip([{ name: "assets/link", data: Buffer.from("/etc/passwd"), externalAttrs: (attrs << 16) >>> 0 }])
      expectReject(buf, "symlink", label)
    })
  }

  it("modo Unix de archivo regular (0x81a4) pasa", () => {
    const buf = writeEvilZip([{ name: "a.json", data: Buffer.from("{}"), externalAttrs: (0x81a4 << 16) >>> 0 }])
    const entries = readZip(buf)
    expect(entries.length).toBe(1)
    expect(entries[0].read().toString()).toBe("{}")
  })
})
