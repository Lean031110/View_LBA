import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import type { ContentBundle, PublicSettings } from "@/lib/types"

/** GET /api/content — bundle público para las pantallas TV (sin datos sensibles) */
export async function GET() {
  try {
    const [settings, promotions, dishes, schedules, socials, ticker, screens] = await Promise.all([
      db.settings.findUnique({ where: { id: "main" } }),
      db.promotion.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.dish.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.schedule.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.socialLink.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.tickerMessage.findMany({ where: { active: true }, orderBy: [{ order: "asc" }] }),
      db.screen.findMany({ where: { active: true }, select: { code: true, name: true, location: true }, orderBy: { code: "asc" } }),
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
      streamRatio: settings?.streamRatio ?? 0.62,
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
      headers: { "Cache-Control": "no-store" },
    })
  } catch (e) {
    return NextResponse.json({ error: "Error cargando contenido" }, { status: 500 })
  }
}
