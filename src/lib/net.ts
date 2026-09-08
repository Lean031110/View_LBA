/**
 * Utilidades de red local (LAN) — detección de la IP del servidor para
 * construir la URL RTMP que el administrador copia en OBS Studio.
 */
import { networkInterfaces } from "os"

export interface LanInterface {
  name: string
  ip: string
}

/** ¿IP privada de LAN? (RFC1918) */
function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith("192.168.")) return true
  if (ip.startsWith("10.")) return true
  const m = ip.match(/^172\.(\d+)\./)
  if (m) {
    const n = Number(m[1])
    return n >= 16 && n <= 31
  }
  return false
}

/** Todas las interfaces IPv4 no internas (LAN primero) */
export function getLanInterfaces(): LanInterface[] {
  const out: LanInterface[] = []
  const nets = networkInterfaces()
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue
      out.push({ name, ip: addr.address })
    }
  }
  // IPs privadas de LAN primero (una IP pública rara vez sirve para OBS en LAN)
  return out.sort((a, b) => Number(isPrivateIPv4(b.ip)) - Number(isPrivateIPv4(a.ip)))
}

/** La mejor IP candidata para el servidor RTMP en LAN */
export function getPrimaryLanIp(): string {
  const ifs = getLanInterfaces()
  const priv = ifs.find((i) => isPrivateIPv4(i.ip))
  return priv?.ip ?? ifs[0]?.ip ?? "127.0.0.1"
}
