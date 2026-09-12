/**
 * TESTS — Pipeline de importación .vtheme (§10 pasos 1–17 + §20 ataques).
 *
 * TODO ataque termina en REJECT SAFE (ThemeError tipado) SIN crash.
 * Los buffers MALICIOSOS se construyen en memoria (helpers).
 */
import { describe, it, expect } from "bun:test"
import { parseVTheme, assertVThemeExtension } from "@/lib/themes/package"
import { writeZip } from "@/lib/themes/zip"
import { ThemeError } from "@/lib/themes/types"
import {
  validVTheme, baseManifest, baseSpec, classicVTheme,
  writeEvilZip, makePng, makePngWithDims, makeJpeg, makeWebP, makeWoff2, makeWoff, zeros,
} from "./helpers"

const V = "3.1.0"

function expectReject(buf: Buffer, code: string, label: string, version = V) {
  try {
    parseVTheme(buf, version)
    throw new Error(`DEBÍA RECHAZAR (${label})`)
  } catch (e) {
    expect(e instanceof ThemeError).toBe(true)
    expect((e as ThemeError).code).toBe(code)
  }
}

describe("parseVTheme — paquetes VÁLIDOS", () => {
  it("paquete canónico parsea: manifest + spec + 0 assets", () => {
    const p = parseVTheme(validVTheme(), V)
    expect(p.manifest.id).toBe("test-theme")
    expect(p.specInput.palette?.primary).toBe("#123456")
    expect(p.assets.length).toBe(0)
  })

  it("paquete Classic (copia del integrado) parsea", () => {
    const p = parseVTheme(classicVTheme(), V)
    expect(p.manifest.name).toBe("ViewLBA Classic")
    expect(p.specInput.palette?.primary).toBe("#d4af37")
  })

  it("paquete con assets válidos (png/jpg/webp/woff2) pasa con dimensiones", () => {
    const png = makePng(1920, 1080)
    const jpg = makeJpeg(800, 600)
    const webp = makeWebP(640, 360)
    const woff2 = makeWoff2()
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "bg.png" } })), "utf8") },
      { name: "assets/", data: Buffer.alloc(0) },
      { name: "assets/bg.png", data: png },
      { name: "assets/photo.jpg", data: jpg },
      { name: "assets/clip.webp", data: webp },
      { name: "assets/custom.woff2", data: woff2 },
    ])
    const p = parseVTheme(buf, V)
    expect(p.assets.length).toBe(4)
    const bg = p.assets.find((a) => a.name === "bg.png")!
    expect(bg.width).toBe(1920)
    expect(bg.height).toBe(1080)
    expect(p.assets.find((a) => a.name === "photo.jpg")!.width).toBe(800)
    expect(p.assets.find((a) => a.name === "custom.woff2")!.width).toBeNull()
  })

  it("theme.json PARCIAL pasa (solo lo que declara; el resto default)", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify({ clock: { style: "neon" } }), "utf8") },
    ])
    const p = parseVTheme(buf, V)
    expect(p.specInput.clock?.style).toBe("neon")
  })
})

describe("parseVTheme — paso 1: extensión", () => {
  it("assertVThemeExtension rechaza .zip / .js / sin extensión", () => {
    for (const f of ["theme.zip", "theme.js", "theme", "theme.VTHEME.bak"]) {
      try {
        assertVThemeExtension(f)
        throw new Error("DEBÍA RECHAZAR extensión")
      } catch (e) {
        expect((e as ThemeError).code).toBe("bad_extension")
      }
    }
    expect(() => assertVThemeExtension("MyTheme.vtheme")).not.toThrow()
  })
})

describe("parseVTheme — estructura del paquete", () => {
  it("falta manifest.json → missing_manifest", () => {
    const buf = writeZip([{ name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") }])
    expectReject(buf, "missing_manifest", "sin manifest")
  })

  it("falta theme.json → missing_theme", () => {
    const buf = writeZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") }])
    expectReject(buf, "missing_theme", "sin theme")
  })

  it("archivo desconocido en la raíz → unknown_file", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      { name: "README.txt", data: Buffer.from("hola") },
    ])
    expectReject(buf, "unknown_file", "README.txt")
  })

  it("directorio desconocido → unknown_file", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      { name: "fonts/", data: Buffer.alloc(0) },
    ])
    expectReject(buf, "unknown_file", "fonts/")
  })

  it("asset en subdirectorio (assets/sub/x.png) → entry_name_invalid", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest()), "utf8") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec()), "utf8") },
      { name: "assets/sub/x.png", data: makePng(10, 10) },
    ])
    expectReject(buf, "entry_name_invalid", "subdirectorio")
  })

  it("id del paquete = id integrado (default/classic/neon) → id_conflict", () => {
    for (const id of ["default", "viewlba-classic", "viewlba-neon"]) {
      expectReject(validVTheme({ id }), "id_conflict", `id reservado ${id}`)
    }
  })
})

describe("parseVTheme — JSON corrupto / grande", () => {
  it("manifest no JSON → bad_json", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from("{no es json") },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
    ])
    expectReject(buf, "bad_json", "manifest roto")
  })

  it("theme.json no objeto (array) → bad_json", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from("[1,2,3]") },
    ])
    expectReject(buf, "bad_json", "theme array")
  })

  it("manifest > 64 KB → json_too_big", () => {
    const big = Buffer.from(JSON.stringify({ ...baseManifest(), description: "x".repeat(400) }) + " ".repeat(65 * 1024))
    const buf = writeZip([
      { name: "manifest.json", data: big },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
    ])
    expectReject(buf, "json_too_big", "manifest 64KB+")
  })

  it("theme.json > 64 KB (muchos campos anidados) → json_too_big", () => {
    const big = Buffer.from(JSON.stringify(baseSpec()) + " ".repeat(65 * 1024))
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: big },
    ])
    expectReject(buf, "json_too_big", "theme 64KB+")
  })
})

describe("parseVTheme — §20 archivos EJECUTABLES/prohibidos", () => {
  const forbidden = [
    ["script.js", Buffer.from("alert(1)"), "forbidden_file"],
    ["run.sh", Buffer.from("#!/bin/sh\nrm -rf /"), "forbidden_file"],
    ["install.bat", Buffer.from("@echo off"), "forbidden_file"],
    ["evil.ps1", Buffer.from("Write-Host x"), "forbidden_file"],
    ["payload.exe", Buffer.from("MZ..."), "forbidden_file"],
    ["lib.dll", Buffer.alloc(64), "forbidden_file"],
    ["module.so", Buffer.alloc(64), "forbidden_file"],
    ["page.html", Buffer.from("<script>alert(1)</script>"), "forbidden_file"],
    ["vector.svg", Buffer.from("<svg onload='alert(1)'/>"), "forbidden_file"],
    ["style.css", Buffer.from("body{background:url(evil)}"), "forbidden_file"],
    ["font.ttf", Buffer.alloc(64), "forbidden_file"],
    ["doc.xml", Buffer.from("<?xml?>"), "forbidden_file"],
  ] as const

  for (const [name, data, code] of forbidden) {
    it(`assets/${name} → ${code}`, () => {
      const buf = writeZip([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
        { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
        { name: `assets/${name}`, data },
      ])
      expectReject(buf, code, name)
    })
  }

  it("script disfrazado en la RAÍZ (no assets/) → unknown_file", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "malware.js", data: Buffer.from("process.exit(1)") },
    ])
    expectReject(buf, "unknown_file", "js en raíz")
  })
})

describe("parseVTheme — MIME falso / extensión falsa (§20)", () => {
  it("JS renombrado a .png (magic bytes no coinciden) → bad_image", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/troyano.png", data: Buffer.from("alert('soy JS')") },
    ])
    expectReject(buf, "bad_image", "js como png")
  })

  it("PNG renombrado a .jpg → bad_image (incoherencia extensión/contenido)", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/foto.jpg", data: makePng(100, 100) },
    ])
    expectReject(buf, "bad_image", "png como jpg")
  })

  it("woff renombrado a .woff2 → bad_image", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/font.woff2", data: makeWoff() },
    ])
    expectReject(buf, "bad_image", "woff como woff2")
  })

  it("exe MZ renombrado a .png → bad_image", () => {
    const exe = Buffer.alloc(64)
    exe[0] = 0x4d
    exe[1] = 0x5a
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/hero.png", data: exe },
    ])
    expectReject(buf, "bad_image", "exe como png")
  })
})

describe("parseVTheme — imágenes gigantes / corruptas (§12/§20)", () => {
  it("PNG con dimensiones 9999×9999 → bad_image (límite 4096)", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/giant.png", data: makePngWithDims(9999, 9999) },
    ])
    expectReject(buf, "bad_image", "9999×9999")
  })

  it("PNG con dimensiones 0×0 → bad_image (ilegible)", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/empty.png", data: makePng(0, 0) },
    ])
    expectReject(buf, "bad_image", "0×0")
  })

  it("PNG truncado (solo firma+IHDR, sin chunks) → bad_image", () => {
    const truncated = makePng(100, 100).subarray(0, 33)
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/cut.png", data: truncated },
    ])
    expectReject(buf, "bad_image", "png truncado")
  })

  it("asset vacío (0 bytes) → bad_image", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/vacio.png", data: Buffer.alloc(0) },
    ])
    expectReject(buf, "bad_image", "asset vacío")
  })

  it("asset de 9 MB (> límite 8 MB) → asset_limit", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
      { name: "assets/grande.png", data: Buffer.concat([makePng(100, 100), zeros(9 * 1024 * 1024)]) },
    ])
    expectReject(buf, "asset_limit", "9 MB")
  })

  it("65 assets (> límite 64) → asset_limit", () => {
    const files = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec())) },
    ]
    for (let i = 0; i < 65; i++) files.push({ name: `assets/a${i}.png`, data: makePng(10, 10) })
    expectReject(writeZip(files), "asset_limit", "65 assets")
  })
})

describe("parseVTheme — referencias de assets (§10.11)", () => {
  it("backgroundImage inexistente → bad_asset_ref", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "no-existe.png" } }))) },
      { name: "assets/otra.png", data: makePng(10, 10) },
    ])
    expectReject(buf, "bad_asset_ref", "ref inexistente")
  })

  it("backgroundImage que apunta a una FUENTE → bad_asset_ref", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "f.woff2" } }))) },
      { name: "assets/f.woff2", data: makeWoff2() },
    ])
    expectReject(buf, "bad_asset_ref", "font como bg")
  })

  it("backgroundImage existente pasa y se resuelve", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify(baseSpec({ assets: { backgroundImage: "bg.png" } }))) },
      { name: "assets/bg.png", data: makePng(1280, 720) },
    ])
    const p = parseVTheme(buf, V)
    expect(p.specInput.assets?.backgroundImage).toBe("bg.png")
  })
})

describe("parseVTheme — compatibilidad (§24)", () => {
  it("schemaVersion 2 → bad_schema (nunca interpretar desconocido)", () => {
    expectReject(validVTheme({ schemaVersion: 2 }), "bad_schema", "schema futuro")
  })

  it("minViewLbaVersion > actual → incompatible", () => {
    expectReject(validVTheme({ minViewLbaVersion: "4.0.0" }), "incompatible", "requiere 4.0.0")
  })

  it("licenseTier 'trial' → wrong_tier", () => {
    expectReject(validVTheme({ licenseTier: "trial" as never }), "wrong_tier", "tier trial")
  })
})

describe("parseVTheme — FUZZ adversarial (nunca crash)", () => {
  it("bytes aleatorios truncados del paquete válido → rechazo tipado", () => {
    const valid = validVTheme()
    for (let cut of [0, 1, 10, 50, 100, valid.length - 1, valid.length - 5, valid.length - 22]) {
      cut = Math.max(0, Math.min(cut, valid.length))
      try {
        parseVTheme(valid.subarray(0, cut), V)
        // un prefijo que aún parsea válido es posible pero improbable; exigir no-crash
      } catch (e) {
        expect(e instanceof ThemeError).toBe(true)
      }
    }
  })

  it("mutaciones de bytes aleatorias → sin crash (ThemeError o nada)", () => {
    const valid = validVTheme()
    for (let i = 0; i < 300; i++) {
      const mutated = Buffer.from(valid)
      const pos = Math.floor(Math.random() * mutated.length)
      mutated[pos] = Math.floor(Math.random() * 256)
      try {
        parseVTheme(mutated, V)
      } catch (e) {
        expect(e instanceof ThemeError).toBe(true)
      }
    }
  })

  it("paquete 'no-zip' con extensión .vtheme → not_zip", () => {
    expectReject(Buffer.from("esto no es un zip, solo texto"), "not_zip", "texto plano")
  })

  it("manifest con unicode raro en campos de texto VÁLIDO pasa (los campos son texto)", () => {
    const p = parseVTheme(validVTheme({ name: "Tema Ünïcödé 中文 🍽" }), V)
    expect(p.manifest.name).toContain("Ünïcödé")
  })

  it("theme.json con claves unicode extrañas → unknown_field", () => {
    const buf = writeZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(baseManifest())) },
      { name: "theme.json", data: Buffer.from(JSON.stringify({ "клон": 1, clock: { style: "classic" } })) },
    ])
    expectReject(buf, "unknown_field", "clave cirílica")
  })
})
