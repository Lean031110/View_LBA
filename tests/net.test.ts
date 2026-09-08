import { describe, expect, it } from "bun:test"
import { getLanInterfaces, getPrimaryLanIp } from "@/lib/net"

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

describe("net — utilidades de red LAN", () => {
  it("getLanInterfaces devuelve interfaces IPv4 externas (nombre + ip)", () => {
    const ifs = getLanInterfaces()
    expect(Array.isArray(ifs)).toBe(true)
    for (const i of ifs) {
      expect(typeof i.name).toBe("string")
      expect(i.name.length).toBeGreaterThan(0)
      expect(i.ip).toMatch(IPV4)
    }
  })

  it("getPrimaryLanIp siempre devuelve una IPv4 válida (fallback 127.0.0.1)", () => {
    expect(getPrimaryLanIp()).toMatch(IPV4)
  })

  it("prioriza IPs privadas RFC1918 cuando existen", () => {
    const ifs = getLanInterfaces()
    const hasPrivate = ifs.some(
      (i) => i.ip.startsWith("192.168.") || i.ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(i.ip)
    )
    if (hasPrivate) expect(getPrimaryLanIp().startsWith("127.")).toBe(false)
  })
})
