import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false, // deliberado: evita dobles efectos en clientes 24/7 (sockets/streams)
};

export default nextConfig;
