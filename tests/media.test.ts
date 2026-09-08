/**
 * Tests de medios (FASE 10): magic bytes, coherencia extensión/contenido,
 * cuota y decisiones de subida.
 */
import { describe, it, expect } from "bun:test"
import {
  detectMediaType,
  extensionMatchesDetected,
  validateUploadBuffer,
  mediaQuotaMB,
  isImageType,
  isVideoType,
} from "@/lib/media"

function png(): Buffer {
  const b = Buffer.alloc(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return b
}
function jpeg(): Buffer {
  const b = Buffer.alloc(64)
  b.set([0xff, 0xd8, 0xff, 0xe0], 0)
  return b
}
function gif(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(58)])
}
function webp(): Buffer {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(52)])
}
function mp4(): Buffer {
  const b = Buffer.alloc(64)
  Buffer.from("ftyp", "ascii").copy(b, 4)
  return b
}
function webm(): Buffer {
  const b = Buffer.alloc(64)
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0)
  return b
}

describe("detectMediaType — magic bytes", () => {
  it("reconoce PNG, JPEG, GIF, WebP", () => {
    expect(detectMediaType(png())).toBe("png")
    expect(detectMediaType(jpeg())).toBe("jpeg")
    expect(detectMediaType(gif())).toBe("gif")
    expect(detectMediaType(webp())).toBe("webp")
  })
  it("reconoce MP4 (ftyp) y WebM (EBML)", () => {
    expect(detectMediaType(mp4())).toBe("mp4")
    expect(detectMediaType(webm())).toBe("webm")
  })
  it("desconocido/pequeño → null", () => {
    expect(detectMediaType(Buffer.alloc(32))).toBeNull()
    expect(detectMediaType(Buffer.from("hola"))).toBeNull()
  })
})

describe("validateUploadBuffer", () => {
  it("PNG real con extensión png pasa", () => {
    expect(validateUploadBuffer(png(), "png", "image/png").ok).toBeTrue()
  })
  it("GIF disfrazado de .png se RECHAZA (mentira de extensión)", () => {
    const r = validateUploadBuffer(gif(), "png", "image/png")
    expect(r.ok).toBeFalse()
  })
  it("PNG disfrazado de .mp4 se rechaza", () => {
    expect(validateUploadBuffer(png(), "mp4", "video/mp4").ok).toBeFalse()
  })
  it("MP4 real con extensión mp4 y MIME video pasa", () => {
    expect(validateUploadBuffer(mp4(), "mp4", "video/mp4").ok).toBeTrue()
  })
  it("jpg y jpeg equivalentes", () => {
    expect(validateUploadBuffer(jpeg(), "jpg", "image/jpeg").ok).toBeTrue()
    expect(validateUploadBuffer(jpeg(), "jpeg", "image/jpeg").ok).toBeTrue()
  })
  it("SVG rechazado por defecto (sin ALLOW_SVG)", () => {
    const r = validateUploadBuffer(Buffer.from("<svg/>"), "svg", "image/svg+xml")
    expect(r.ok).toBeFalse()
    expect(r.reason).toContain("SVG")
  })
  it("SVG permitido con ALLOW_SVG=true", () => {
    process.env.ALLOW_SVG = "true"
    try {
      expect(validateUploadBuffer(Buffer.from("<svg/>"), "svg", "image/svg+xml").ok).toBeTrue()
    } finally {
      delete process.env.ALLOW_SVG
    }
  })
  it("contenido basura se rechaza", () => {
    expect(validateUploadBuffer(Buffer.alloc(64, 7), "png", "image/png").ok).toBeFalse()
  })
  it("MIME declarado implausible se rechaza", () => {
    expect(validateUploadBuffer(png(), "png", "video/mp4").ok).toBeFalse()
  })
})

describe("helpers", () => {
  it("extensionMatchesDetected jpeg/jpg", () => {
    expect(extensionMatchesDetected("jpg", "jpeg")).toBeTrue()
    expect(extensionMatchesDetected("jpeg", "jpeg")).toBeTrue()
    expect(extensionMatchesDetected("png", "jpeg")).toBeFalse()
  })
  it("isImageType / isVideoType", () => {
    expect(isImageType("png")).toBeTrue()
    expect(isImageType("mp4")).toBeFalse()
    expect(isVideoType("mp4")).toBeTrue()
    expect(isVideoType(null)).toBeFalse()
  })
  it("mediaQuotaMB default 2048, configurable", () => {
    expect(mediaQuotaMB()).toBe(2048)
    process.env.MEDIA_MAX_TOTAL_MB = "512"
    try {
      expect(mediaQuotaMB()).toBe(512)
    } finally {
      delete process.env.MEDIA_MAX_TOTAL_MB
    }
  })
})
