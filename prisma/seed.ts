/* Seed inicial — ViewLBA (señalización digital para restaurantes)
   Ejecutar: bun prisma/seed.ts
*/
import { PrismaClient } from "@prisma/client"
import { randomBytes, scryptSync } from "crypto"

const db = new PrismaClient()

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

async function main() {
  console.log("Seeding database...")

  // ---- Users ----
  await db.user.upsert({
    where: { email: "admin@restaurante.com" },
    update: {},
    create: {
      email: "admin@restaurante.com",
      name: "Administrador",
      passwordHash: hashPassword("admin123"),
      role: "ADMIN",
    },
  })
  await db.user.upsert({
    where: { email: "operador@restaurante.com" },
    update: {},
    create: {
      email: "operador@restaurante.com",
      name: "Operador",
      passwordHash: hashPassword("operador123"),
      role: "OPERATOR",
    },
  })

  // ---- Screens ----
  const screens = [
    { code: "TV-001", name: "TV Salón Principal", location: "Salón principal" },
    { code: "TV-002", name: "TV Área de Espera", location: "Entrada" },
    { code: "TV-003", name: "TV Cocina", location: "Cocina" },
  ]
  for (const s of screens) {
    await db.screen.upsert({ where: { code: s.code }, update: {}, create: s })
  }

  // ---- Schedules ----
  if ((await db.schedule.count()) === 0) {
    await db.schedule.createMany({
      data: [
        { name: "DESAYUNO", startTime: "07:00", endTime: "11:00", icon: "coffee", color: "#f5a623", order: 1 },
        { name: "ALMUERZO", startTime: "11:00", endTime: "15:00", icon: "sun", color: "#f5a623", order: 2 },
        { name: "CENA", startTime: "18:00", endTime: "23:00", icon: "moon", color: "#f5a623", order: 3 },
      ],
    })
  }

  // ---- Promotions ----
  if ((await db.promotion.count()) === 0) {
    await db.promotion.createMany({
      data: [
        {
          title: "BACONBURGER",
          description: "Doble carne a la parrilla, bacon crocante y queso cheddar fundido",
          price: "$299",
          oldPrice: "$399",
          discount: "20% OFF",
          badge: "PROMO DE HOY",
          imageUrl: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/a413db1adb6c.jpg",
          duration: 10,
          priority: 10,
          order: 1,
        },
        {
          title: "PIZZA FAMILIAR",
          description: "2x1 en pizzas grandes todos los días de 12:00 a 17:00",
          price: "$580",
          oldPrice: "$1160",
          discount: "2X1",
          badge: "ESPECIAL",
          imageUrl: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/e93fcaf83a3e.jpg",
          duration: 10,
          priority: 8,
          order: 2,
        },
        {
          title: "HAPPY HOUR",
          description: "Mojitos y cócteles de la casa a mitad de precio",
          price: "$150",
          oldPrice: "$300",
          discount: "50% OFF",
          badge: "SOLO HOY",
          duration: 8,
          priority: 5,
          order: 3,
        },
      ],
    })
  }

  // ---- Sugerencias del día (varias → rotan en la pantalla) ----
  if ((await db.dish.count()) === 0) {
    await db.dish.createMany({
      data: [
        {
          name: "CLUB SANDWICH",
          description: "Pan artesanal, pollo, bacon, queso y vegetales frescos",
          price: "$450",
          imageUrl: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/837bda23b10a.jpg",
          ingredients: "Pollo · Bacon · Queso · Lechuga · Tomate · Mayonesa de la casa",
          tag: "RECOMENDADO",
          order: 1,
        },
        {
          name: "SALMÓN A LA PARRILLA",
          description: "Salmón noruego con mantequilla de limón y hierbas",
          price: "$680",
          imageUrl: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/f7d21527356a.jpg",
          ingredients: "Salmón · Limón · Eneldo · Mantequilla",
          tag: "CHEF",
          order: 2,
        },
        {
          name: "TACOS DE CAMARÓN",
          description: "Tortilla de maíz, camarones empanizados y salsa de mango",
          price: "$520",
          imageUrl: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/d45b0a87332d.jpg",
          ingredients: "Camarón · Mango · Aguacate · Cilantro",
          tag: "NUEVO",
          order: 3,
        },
      ],
    })
  }

  // ---- Social links (Facebook · Instagram · WhatsApp) ----
  if ((await db.socialLink.count()) === 0) {
    await db.socialLink.createMany({
      data: [
        { network: "FACEBOOK", username: "@laterraza", order: 1, color: "#1877f2" },
        { network: "INSTAGRAM", username: "@laterraza.grill", order: 2, color: "#e1306c" },
        { network: "WHATSAPP", username: "+53 5 555 1234", order: 3, color: "#25d366" },
      ],
    })
  }

  // ---- Ticker ----
  if ((await db.tickerMessage.count()) === 0) {
    await db.tickerMessage.createMany({
      data: [
        { text: "Nuevas promociones disponibles", order: 1 },
        { text: "Visítanos hoy", order: 2 },
        { text: "Síguenos en nuestras redes sociales", order: 3 },
        { text: "Especial del día: Club Sandwich", order: 4 },
        { text: "Happy Hour de 17:00 a 19:00", order: 5 },
      ],
    })
  }

  // ---- Settings ----
  await db.settings.upsert({
    where: { id: "main" },
    update: {},
    create: {
      id: "main",
      restaurantName: "La Terraza Grill & Bar",
      // Stream: sin URL → estado "ESPERANDO TRANSMISIÓN" con fallback elegante
      streamEnabled: true,
      streamUrl: "",
      fallbackType: "message",
      fallbackMessage: "LA TRANSMISIÓN SE REANUDARÁ EN BREVE",
      tickerSpeed: 55,
      streamRatio: 0.5,
    },
  })

  console.log("✅ Seed completado. Usuarios: admin@restaurante.com / admin123 · operador@restaurante.com / operador123")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
