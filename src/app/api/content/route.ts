import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"
import { db } from "@/lib/db"
import type { ContentBundle, PublicSettings } from "@/lib/types"

/**
 * GET /api/content — bundle público para las pantallas TV (sin datos sensibles).
 *
 * FASE 37 (caching): ETag de SELLO DE VERSIÓN — una única consulta agregada
 * barata (COUNT + MAX(updatedAt) por tabla; el COUNT detecta también BORRADOS,
 * que el MAX solo no vería). Si el cliente manda If-None-Match y el sello no
 * cambió → 304 SIN ejecutar las 7 consultas ni serializar el bundle.
 * Cache-Control: no-cache (almacenar y SIEMPRE revalidar) — la TV refresca
 * por eventos realtime; cada refresco sin cambios cuesta una consulta en
 * vez del bundle completo. El SW offline ya filtra los 304 (res.ok=false).
 */
async function contentVersionStamp(): Promise<string> {
  const row = (await db.$queryRawUnsafe(
    `SELECT
      (SELECT COUNT(*) FROM Settings) AS c0, (SELECT MAX(updatedAt) FROM Settings) AS m0,
      (SELECT COUNT(*) FROM Promotion) AS c1, (SELECT MAX(updatedAt) FROM Promotion) AS m1,
      (SELECT COUNT(*) FROM Dish) AS c2, (SELECT MAX(updatedAt) FROM Dish) AS m2,
      (SELECT COUNT(*) FROM Schedule) AS c3, (SELECT MAX(updatedAt) FROM Schedule) AS m3,
      (SELECT COUNT(*) FROM SocialLink) AS c4, (SELECT MAX(updatedAt) FROM SocialLink) AS m4,
      (SELECT COUNT(*) FROM TickerMessage) AS c5, (SELECT MAX(updatedAt) FROM TickerMessage) AS m5,
      (SELECT COUNT(*) FROM Screen) AS c6, (SELECT MAX(updatedAt) FROM Screen) AS m6`
  )) as Array<Record<string, string | number | null>>
  const r = row[0] ?? {}
  // NOTA: Prisma mapea COUNT(*) a BigInt → replacer stringify-safe
  return createHash("sha256")
    .update(
      JSON.stringify([r.c0, r.m0, r.c1, r.m1, r.c2, r.m2, r.c3, r.m3, r.c4, r.m4, r.c5, r.m5, r.c6, r.m6], (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      )
    )
    .digest("hex")
    .slice(0, 20)
}

export async function GET(req: NextRequest) {
  try {
    // FASE 37: revalidación barata ANTES de construir el bundle
    const etag = `"c-${await contentVersionStamp()}"`
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-cache, must-revalidate" },
      })
    }

    const [settings, promotions, dishes, schedules, socials, ticker, screens] = await Promise.all([
      db.settings.findUnique({ where: { id: "main" } }),
      db.promotion.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.dish.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.schedule.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.socialLink.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.tickerMessage.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.screen.findMany({ where: { active: true }, select: { code: true, name: true, location: true, audioDeviceId: true }, orderBy: { code: "asc" } }),
    ])

    // Sanitizar: NUNCA exponer streamKey / streamServer al cliente público
    const publicSettings: PublicSettings = {
      restaurantName: settings?.restaurantName ?? "Restaurante",
      logoUrl: settings?.logoUrl ?? null,
      logoSize: settings?.logoSize ?? "md",
      logoPosition: settings?.logoPosition ?? "right",
      clockFormat: settings?.clockFormat ?? "12",
      showDate: settings?.showDate ?? true,
      showSeconds: settings?.showSeconds ?? false,
      showDay: settings?.showDay ?? true,
      timezone: settings?.timezone ?? "America/Havana",
      language: settings?.language ?? "es",
      streamEnabled: settings?.streamEnabled ?? true,
      streamSource: settings?.streamSource ?? "external", // local | external (sin secretos)
      streamUrl: settings?.streamUrl ?? "",
      streamProtocol: settings?.streamProtocol ?? "hls",
      autoplay: settings?.autoplay ?? true,
      fallbackType: settings?.fallbackType ?? "message",
      fallbackMessage: settings?.fallbackMessage ?? "LA TRANSMISIÓN SE REANUDARÁ EN BREVE",
      fallbackImageUrl: settings?.fallbackImageUrl ?? null,
      fallbackVideoUrl: settings?.fallbackVideoUrl ?? null,
      audioVolume: settings?.audioVolume ?? 80,
      audioMuted: settings?.audioMuted ?? true,
      audioDeviceId: settings?.audioDeviceId ?? null,
      tickerEnabled: settings?.tickerEnabled ?? true,
      tickerSpeed: settings?.tickerSpeed ?? 55,
      tickerPaused: settings?.tickerPaused ?? false,
      primaryColor: settings?.primaryColor ?? "#f5a623",
      accentColor: settings?.accentColor ?? "#e8452c",
      bgColor: settings?.bgColor ?? "#0b0b0f",
      surfaceColor: settings?.surfaceColor ?? "#15151b",
      fontScale: settings?.fontScale ?? 1,
      streamRatio: settings?.streamRatio ?? 0.5,
      animationsEnabled: settings?.animationsEnabled ?? true,
      animationSpeed: settings?.animationSpeed ?? 1,
      showPromotions: settings?.showPromotions ?? true,
      showDish: settings?.showDish ?? true,
      showSocials: settings?.showSocials ?? true,
      showSchedule: settings?.showSchedule ?? true,
      showTicker: settings?.showTicker ?? true,
    }

    const bundle: ContentBundle = {
      settings: publicSettings,
      promotions: promotions.map((p) => ({ ...p, startDate: p.startDate?.toISOString() ?? null, endDate: p.endDate?.toISOString() ?? null })),
      dishes: dishes.map((d) => ({ ...d, date: d.date?.toISOString() ?? null })),
      schedules,
      socials,
      ticker,
      screens,
      serverTime: new Date().toISOString(),
    }

    return NextResponse.json(bundle, {
      headers: { "Cache-Control": "no-cache, must-revalidate", ETag: etag },
    })
  } catch (e) {
    return NextResponse.json({ error: "Error cargando contenido" }, { status: 500 })
  }
}
