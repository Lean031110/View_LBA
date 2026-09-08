/**
 * Activa el modo de transmisión LOCAL (servidor RTMP integrado en LAN).
 * - streamSource = "local"
 * - Genera una streamKey segura si no existe
 * - Conserva la URL externa anterior por si el usuario quiere volver a ella
 */
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

function randomKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
  let out = ""
  const rnd = new Uint32Array(24)
  crypto.getRandomValues(rnd)
  for (let i = 0; i < 24; i++) out += chars[rnd[i] % chars.length]
  return out
}

async function main() {
  const s = await db.settings.findUnique({ where: { id: "main" } })
  if (!s) throw new Error("No existe Settings(main) — ejecutar seed inicial primero")
  const key = s.streamKey?.trim() ? s.streamKey : randomKey()
  await db.settings.update({
    where: { id: "main" },
    data: {
      streamSource: "local",
      streamKey: key,
      // conservar streamUrl externa para poder alternar; se limpia el demo de Internet
      streamUrl: s.streamUrl?.includes("test-streams.mux.dev") ? null : s.streamUrl,
    },
  })
  console.log(`OK streamSource=local · streamKey=${key.slice(0, 4)}**** (generada/conservada)`)
}

main().finally(() => db.$disconnect())
