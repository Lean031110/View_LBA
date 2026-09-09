import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  // FASE 21 (misión): StrictMode ACTIVADO — todos los efectos del display
  // son idempotentes con cleanup completo (sockets, players, timers,
  // listeners, wake lock), verificado en dev con doble montaje.
  reactStrictMode: true,
  // Next 16.3+ bloquea por seguridad los recursos de desarrollo desde orígenes
  // cruzados (p.ej. abrir http://127.0.0.1:3000 cuando el server anuncia
  // localhost:3000). En despliegues LAN de desarrollo las TVs acceden por la
  // IP del servidor → se permiten hosts explícitos (producción no se afecta).
  allowedDevOrigins: ["127.0.0.1", "localhost", "21.0.6.110"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

const isDev = process.env.NODE_ENV !== "production"

/**
 * FASE 35 (misión): headers de seguridad globales.
 *  · CSP prudente para TV+admin (LAN): script/style inline son necesarios
 *    (bootstrap de Next + framer-motion estilos inline); 'unsafe-eval' SOLO
 *    en desarrollo (React Refresh); connect-src ws: porque el realtime vive
 *    en OTRO PUERTO (cross-origin para CSP aunque sea el mismo host LAN);
 *    media-src blob: por el pipeline MSE de mpegts.js.
 *  · X-Frame-Options SAMEORIGIN: la TV/admin no deben ser embebidos por
 *    terceros (clickjacking); frame-ancestors 'self' equivalente en CSP.
 *  · HSTS: NO — los despliegues LAN documentados son http (forzarlo dejaría
 *    a las TVs fuera). Aplicarlo solo si algún día se sirve tras https.
 */
const csp = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
]

export default nextConfig
