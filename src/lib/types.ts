/** Tipos compartidos cliente/servidor */

import type { PublicTheme, ThemeSpec } from "@/lib/themes/types"

export type { PublicTheme, ThemeSpec }

export interface PublicSettings {
  restaurantName: string
  logoUrl: string | null
  logoSize: string
  logoPosition: string
  clockFormat: string
  showDate: boolean
  showSeconds: boolean
  showDay: boolean
  timezone: string
  language: string
  streamEnabled: boolean
  streamSource: string
  streamUrl: string
  streamProtocol: string
  autoplay: boolean
  fallbackType: string
  fallbackMessage: string
  fallbackImageUrl: string | null
  fallbackVideoUrl: string | null
  audioVolume: number
  audioMuted: boolean
  audioDeviceId: string | null
  tickerEnabled: boolean
  tickerSpeed: number
  tickerPaused: boolean
  primaryColor: string
  accentColor: string
  bgColor: string
  surfaceColor: string
  fontScale: number
  streamRatio: number
  animationsEnabled: boolean
  animationSpeed: number
  showPromotions: boolean
  showDish: boolean
  showSocials: boolean
  showSchedule: boolean
  showTicker: boolean
}

export interface PromotionDTO {
  id: string
  title: string
  description: string | null
  price: string | null
  oldPrice: string | null
  discount: string | null
  badge: string | null
  imageUrl: string | null
  startDate: string | null
  endDate: string | null
  startTime: string | null
  endTime: string | null
  duration: number
  priority: number
  order: number
  active: boolean
}

export interface DishDTO {
  id: string
  name: string
  description: string | null
  price: string | null
  imageUrl: string | null
  ingredients: string | null
  tag: string | null
  nutrition: string | null
  dayOfWeek: number | null
  date: string | null
  active: boolean
  order: number
}

export interface ScheduleDTO {
  id: string
  name: string
  startTime: string
  endTime: string
  dayOfWeek: number | null
  icon: string | null
  color: string | null
  active: boolean
  order: number
}

export interface SocialLinkDTO {
  id: string
  network: string
  username: string | null
  url: string | null
  color: string | null
  active: boolean
  order: number
}

export interface TickerMessageDTO {
  id: string
  text: string
  active: boolean
  order: number
}

export interface ContentBundle {
  settings: PublicSettings
  /** Tema TV activo (resuelto con fallback a Default — §14). */
  theme: PublicTheme
  promotions: PromotionDTO[]
  dishes: DishDTO[]
  schedules: ScheduleDTO[]
  socials: SocialLinkDTO[]
  ticker: TickerMessageDTO[]
  screens: { code: string; name: string; location: string | null; audioDeviceId: string | null }[]
  /** Estado público de licencia para la TV (watermark) — sin datos privados. */
  license: PublicLicenseInfo
  serverTime: string
}

/** Resumen de licencia seguro para la pantalla TV (sección 13/16). */
export interface PublicLicenseInfo {
  status: "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"
  watermark: boolean
  watermarkLines: string[] | null
}

export type StreamState = "live" | "connecting" | "offline" | "fallback" | "disabled"

export interface ScreenStatus {
  screenCode: string
  resolution: string
  userAgent: string
  connectedAt: number
  lastSeen: number
  online: boolean
  verified?: boolean // ¿presentó token de pairing válido? (FASE 5)
  streamState: StreamState
  streamInfo: {
    resolution?: string
    bitrate?: number
    latency?: number
    uptime?: number
    reconnects?: number
  }
  // FASE 7: dispositivos de audio reportados por la propia pantalla
  audioInfo?: {
    devices: { deviceId: string; label: string }[]
    supportsSinkId: boolean
    reportedAt: number
  } | null
}
