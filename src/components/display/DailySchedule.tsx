"use client"

import { useEffect, useState } from "react"
import { Coffee, Sun, Moon, UtensilsCrossed, Star, Clock, Wine, Croissant, Soup, Sparkles, type LucideIcon } from "lucide-react"
import type { ScheduleDTO } from "@/lib/types"

const ICONS: Record<string, LucideIcon> = {
  coffee: Coffee,
  sun: Sun,
  moon: Moon,
  utensils: UtensilsCrossed,
  star: Star,
  clock: Clock,
  wine: Wine,
  croissant: Croissant,
  soup: Soup,
  sparkles: Sparkles,
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

function isScheduleActive(s: ScheduleDTO, nowMinutes: number): boolean {
  const start = toMinutes(s.startTime)
  const end = toMinutes(s.endTime)
  if (end > start) return nowMinutes >= start && nowMinutes < end
  // horario que cruza medianoche (ej. 22:00 - 02:00)
  return nowMinutes >= start || nowMinutes < end
}

/** HORARIO DE HOY: franja con los turnos; el activo se destaca. */
export default function DailySchedule({ schedules, animationsEnabled }: { schedules: ScheduleDTO[]; animationsEnabled: boolean }) {
  const [nowMinutes, setNowMinutes] = useState(() => {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  })

  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date()
      setNowMinutes(d.getHours() * 60 + d.getMinutes())
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  const today = new Date().getDay()
  const visible = schedules
    .filter((s) => s.dayOfWeek === null || s.dayOfWeek === undefined || s.dayOfWeek === today)
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))

  if (visible.length === 0) return null

  return (
    <div className="flex flex-col justify-center min-w-0" aria-label="Horario de hoy">
      <span
        className="tv-font-display leading-none text-white/55"
        style={{ fontSize: "calc(1.55vh * var(--fscale, 1))", letterSpacing: "0.22em" }}
      >
        HORARIO DE HOY
      </span>
      <div className="flex items-center gap-[0.9vw] flex-wrap">
        {visible.map((s) => {
          const active = isScheduleActive(s, nowMinutes)
          const Icon = ICONS[s.icon ?? ""] ?? Clock
          return (
            <div
              key={s.id}
              className="flex items-center gap-[0.55vw] rounded-[0.7vh] px-[1vw] py-[0.55vh] border transition-all duration-700"
              style={{
                borderColor: active ? "var(--tv-primary)" : "rgba(255,255,255,0.14)",
                background: active ? "color-mix(in srgb, var(--tv-primary) 14%, transparent)" : "rgba(255,255,255,0.04)",
                boxShadow: active && animationsEnabled ? "0 0 1.6vh 0 color-mix(in srgb, var(--tv-primary) 35%, transparent)" : "none",
              }}
            >
              <Icon size="calc(2.2vh * var(--fscale, 1))" strokeWidth={2} style={{ color: active ? "var(--tv-primary)" : "rgba(255,255,255,0.5)" }} />
              <div className="flex flex-col leading-none">
                <span
                  className="tv-font-display"
                  style={{
                    fontSize: "calc(1.9vh * var(--fscale, 1))",
                    color: active ? "#fff" : "rgba(255,255,255,0.75)",
                  }}
                >
                  {s.name}
                </span>
                <span
                  className="font-medium tracking-wide text-white/55"
                  style={{ fontSize: "calc(1.45vh * var(--fscale, 1))" }}
                >
                  {s.startTime} – {s.endTime}
                </span>
              </div>
              {active && (
                <span
                  className="tv-font-display rounded px-[0.5vw] py-[0.15vh]"
                  style={{ fontSize: "calc(1.35vh * var(--fscale, 1))", background: "var(--tv-primary)", color: "#1a1208" }}
                >
                  AHORA
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
