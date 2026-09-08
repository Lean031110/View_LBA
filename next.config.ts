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
}

export default nextConfig
