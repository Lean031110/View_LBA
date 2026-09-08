import { io, type Socket } from "socket.io-client"

/**
 * Conexión al servicio realtime según el entorno:
 *
 *  1. Vía gateway (puerto 81 / 443, sandbox y preview): la petición pasa por
 *     Caddy, que enruta XTransformPort=3003 al servicio socket.io.
 *  2. Directa al mismo host (despliegue LAN sin gateway, o desarrollo local):
 *     ws(s)://<host>:3003 — así funciona en el restaurante real, donde los
 *     televisores abren http://<IP-del-servidor>:3000 directamente.
 */
function buildSocketUrl(): string {
  if (typeof window === "undefined") return "/?XTransformPort=3003"
  const { protocol, hostname, port } = window.location
  const gatewayLike = port === "" || port === "81" || port === "443"
  if (gatewayLike) return "/?XTransformPort=3003"
  const scheme = protocol === "https:" ? "wss" : "ws"
  return `${scheme}://${hostname}:3003`
}

const COMMON_OPTS = {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity, // pantalla 24/7
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 10000,
}

/** Conexión al servicio realtime (TV o admin). */
export function connectSocket(): Socket {
  return io(buildSocketUrl(), { ...COMMON_OPTS, path: "/" })
}

/** URL calculada (útil para diagnóstico / logging) */
export function socketUrl(): string {
  return buildSocketUrl()
}
