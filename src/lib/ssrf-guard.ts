/**
 * Guard SSRF (FASE 12 de la misión).
 *
 * PROBLEMA: /api/admin/stream-test recibía una URL y el servidor la fetcheaba
 * → un admin podía convertir el backend en proxy arbitrario hacia la red
 * interna (localhost, NMS, DB, routers, metadata endpoints de cloud).
 *
 * SOLUCIÓN: por defecto SOLO se permiten hosts públicos. Hosts/IPs internos
 * (loopback, link-local, RFC1918, IPv6 unique-local, metadata) se BLOQUEAN
 * salvo lista explícita STREAM_TEST_ALLOWED_HOSTS (destinos LAN autorizados).
 */

export interface SsrfCheckResult {
  allowed: boolean
  reason?: string
}

const ALLOWED_EXTRA = () =>
  (process.env.STREAM_TEST_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

/** ¿IPv4 privada RFC1918? */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 127) return true // loopback
  if (a === 0) return true // 0.0.0.0/8
  if (a === 169 && b === 254) return true // link-local + metadata 169.254.169.254
  if (a >= 224) return true // multicast / reservado
  return false
}

/** ¿Host interno? (loopback, privadas, link-local, IPv6 especial, .local, .internal) */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true // link-local / unique-local IPv6
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true
  if (h === "metadata.google.internal") return true
  return isPrivateIPv4(h)
}

/**
 * ¿Se permite que el SERVIDOR fetchee esta URL?
 * - null/undefined → bloqueado (campo ausente)
 * - Solo http/https
 * - Host interno → bloqueado salvo lista explícita
 */
export function checkSsrfUrl(rawUrl: string | null | undefined): SsrfCheckResult {
  if (!rawUrl || typeof rawUrl !== "string") return { allowed: false, reason: "URL requerida" }
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: "URL no válida" }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { allowed: false, reason: `Protocolo no permitido (${u.protocol})` }
  }
  const host = u.hostname.toLowerCase()
  if (ALLOWED_EXTRA().includes(host)) return { allowed: true }
  if (isInternalHost(host)) {
    return {
      allowed: false,
      reason: `Destino interno no autorizado (${host}). Añádelo a STREAM_TEST_ALLOWED_HOSTS si es un destino LAN legítimo`,
    }
  }
  return { allowed: true }
}
