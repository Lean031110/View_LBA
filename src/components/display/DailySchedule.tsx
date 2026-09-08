"use client"

import { useEffect, useMemo, useState } from "react"
import { Coffee, Sun, Moon, UtensilsCrossed, Star, Clock, Wine, Croissant, Soup, Sparkles, type LucideIcon } from "lucide-react"
import type { ScheduleDTO } from "@/lib/types"
import { getTimeParts, hhmmToMinutes, inTimeWindow } from "@/lib/timezone"

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

function isScheduleActive(s: ScheduleDTO, nowMinutes: number): boolean {
  const start = hhmmToMinutes(s.startTime)
  const end = hhmmToMinutes(s.endTime)
  // Horas corruptas en DB (legado) → no marcar como activo
  if (start === null || end === null) return false
  // inTimeWindow soporta franjas que cruzan medianoche (22:00 - 02:00)
  return inTimeWindow(nowMinutes, start, end)
}

/** HORARIO DE HOY: franja con los turnos; el activo se destaca.
 *  FASE 8: la hora y el día se evalúan en la zona horaria del RESTAURANTE
 *  (prop timezone de Settings), no en la del navegador de la TV. */
export default function DailySchedule({ schedules, animationsEnabled, timezone }: { schedules: ScheduleDTO[]; animationsEnabled: boolean; timezone?: string }) {
  const tz = timezone || "America/Havana"
  const [parts, setParts] = useState(() => getTimeParts(new Date(), tz))

  useEffect(() => {
    const id = setInterval(() => setParts(getTimeParts(new Date(), tz)), 30_000)
    return () => clearInterval(id)
  }, [tz])

  const visible = useMemo(
    () =>
      schedules
        .filter((s) => s.dayOfWeek === null || s.dayOfWeek === undefined || s.dayOfWeek === parts.weekday)
        .sort((a, b) => (hhmmToMinutes(a.startTime) ?? 0) - (hhmmToMinutes(b.startTime) ?? 0)),
    [schedules, parts.weekday]
  )

  const nowMinutes = parts.minutes

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
