import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false, // deliberado: evita dobles efectos en clientes 24/7 (sockets/streams) — FASE 21 lo activará
  // Next 16.3+ bloquea por seguridad los recursos de desarrollo desde orígenes
  // cruzados (p.ej. abrir http://127.0.0.1:3000 cuando el server anuncia
  // localhost:3000). En despliegues LAN de desarrollo las TVs acceden por la
  // IP del servidor → se permiten hosts explícitos (producción no se afecta).
  allowedDevOrigins: ["127.0.0.1", "localhost", "21.0.6.110"],
}

export default nextConfig
