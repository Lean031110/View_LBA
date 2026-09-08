/* Migración UI v1.1 — ViewLBA
   - Redes sociales: dejar solo FACEBOOK / INSTAGRAM / WHATSAPP (quita TikTok y YouTube)
   - streamRatio 0.5 → promociones más anchas junto a la transmisión
   - Añadir sugerencias demo para ver el banner rotativo
   Ejecutar: bun scripts/update-ui-v1.1.ts
*/
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  console.log("Migrando UI v1.1...")

  // 1) Redes: fuera TikTok y YouTube (por ahora)
  const removed = await db.socialLink.deleteMany({ where: { network: { in: ["TIKTOK", "YOUTUBE"] } } })
  console.log(`Redes eliminadas: ${removed.count}`)

  // Reordenar las que quedan (1..n)
  const socials = await db.socialLink.findMany({ orderBy: [{ order: "asc" }, { createdAt: "asc" }] })
  let i = 1
  for (const s of socials) {
    if (s.order !== i) await db.socialLink.update({ where: { id: s.id }, data: { order: i } })
    i++
  }
  console.log(`Redes activas: ${socials.map((s) => s.network).join(" · ")}`)

  // 2) Promociones más anchas: columna izquierda al 50%
  await db.settings.update({ where: { id: "main" }, data: { streamRatio: 0.5 } })
  console.log("streamRatio → 0.5")

  // 3) Sugerencias demo (para ver el auto-slide del banner)
  const dishCount = await db.dish.count()
  if (dishCount < 2) {
    await db.dish.createMany({
      data: [
        {
          name: "SALMÓN A LA PARRILLA",
          description: "Salmón noruego con mantequilla de limón y hierbas",
          price: "$680",
          imageUrl: "/demo/salmon.jpg",
          ingredients: "Salmón · Limón · Eneldo · Mantequilla",
          tag: "CHEF",
          order: 2,
        },
        {
          name: "TACOS DE CAMARÓN",
          description: "Tortilla de maíz, camarones empanizados y salsa de mango",
          price: "$520",
          imageUrl: "/demo/tacos.jpg",
          ingredients: "Camarón · Mango · Aguacate · Cilantro",
          tag: "NUEVO",
          order: 3,
        },
      ],
    })
    console.log("Añadidas 2 sugerencias demo (rotan en el banner)")
  } else {
    console.log(`Ya hay ${dishCount} platos — no se añaden demo`)
  }

  console.log("✅ Migración completada")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
