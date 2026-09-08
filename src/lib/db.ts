import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Log de queries solo en desarrollo (FASE 1: producción sin ruido ni
    // posible fuga de datos en logs)
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error"],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db