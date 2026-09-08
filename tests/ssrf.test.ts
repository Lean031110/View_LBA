/**
 * Tests del guard SSRF (FASE 12).
 */
import { describe, it, expect, afterEach } from "bun:test"
import { checkSsrfUrl } from "@/lib/ssrf-guard"

describe("checkSsrfUrl — destinos internos BLOQUEADOS por defecto", () => {
  const blocked = [
    "http://localhost:3000/x",
    "http://127.0.0.1:8100/status",
    "http://127.0.0.1:8000/live/clave.flv",
    "http://0.0.0.0/x",
    "http://[::1]:3000/x",
    "http://169.254.169.254/latest/meta-data/", // metadata cloud
    "http://192.168.1.1/", // router
    "http://10.0.0.5:1935/live",
    "http://172.16.0.1/x",
    "http://172.31.255.255/x",
    "http://metadata.google.internal/x",
    "http://servidor.local/x",
    "http://nas.internal/x",
    "http://192.168.1.50:8000/live/clave.flv",
  ]
  for (const url of blocked) {
    it(`bloquea ${url}`, () => {
      const r = checkSsrfUrl(url)
      expect(r.allowed).toBeFalse()
    })
  }
})

describe("checkSsrfUrl — destinos públicos permitidos", () => {
  const allowed = [
    "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "http://cdn.ejemplo.com/video.mp4",
    "https://8.8.8.8/live.m3u8",
    "https://stream.ejemplo.es/live.m3u8",
  ]
  for (const url of allowed) {
    it(`permite ${url}`, () => {
      const r = checkSsrfUrl(url)
      expect(r.allowed).toBeTrue()
    })
  }
})

describe("checkSsrfUrl — esquemas y URLs inválidas", () => {
  it("file://, ftp://, javascript: rechazados", () => {
    for (const url of ["file:///etc/passwd", "ftp://x/y", "javascript:alert(1)"]) {
      expect(checkSsrfUrl(url).allowed).toBeFalse()
    }
  })
  it("null/undefined/no-URL rechazados", () => {
    expect(checkSsrfUrl(null).allowed).toBeFalse()
    expect(checkSsrfUrl(undefined).allowed).toBeFalse()
    expect(checkSsrfUrl("no soy url").allowed).toBeFalse()
  })
})

describe("checkSsrfUrl — STREAM_TEST_ALLOWED_HOSTS explícito", () => {
  afterEach(() => {
    delete process.env.STREAM_TEST_ALLOWED_HOSTS
  })
  it("host LAN autorizado explícitamente pasa", () => {
    process.env.STREAM_TEST_ALLOWED_HOSTS = "192.168.1.50, rtmp.mi-casa.local"
    expect(checkSsrfUrl("http://192.168.1.50:1935/live/clave").allowed).toBeTrue()
    expect(checkSsrfUrl("http://rtmp.mi-casa.local:1935/live").allowed).toBeTrue()
  })
  it("otros hosts internos siguen bloqueados aunque haya lista", () => {
    process.env.STREAM_TEST_ALLOWED_HOSTS = "192.168.1.50"
    expect(checkSsrfUrl("http://192.168.1.1/admin").allowed).toBeFalse() // router ≠ autorizado
    expect(checkSsrfUrl("http://127.0.0.1:8100/status").allowed).toBeFalse() // localhost nunca implícito
  })
})

describe("checkSsrfUrl — IPv4 edge cases", () => {
  it("172.x fuera de 16-31 es público", () => {
    expect(checkSsrfUrl("http://172.32.0.1/x").allowed).toBeTrue()
    expect(checkSsrfUrl("http://172.15.0.1/x").allowed).toBeTrue()
    expect(checkSsrfUrl("http://172.16.0.1/x").allowed).toBeFalse()
    expect(checkSsrfUrl("http://172.31.0.1/x").allowed).toBeFalse()
  })
  it("multicast/reservado bloqueado", () => {
    expect(checkSsrfUrl("http://224.0.0.1/x").allowed).toBeFalse()
    expect(checkSsrfUrl("http://255.255.255.255/x").allowed).toBeFalse()
  })
})
