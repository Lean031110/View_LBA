"use client"

import { useEffect, useState } from "react"

interface ClockProps {
  clockFormat: string // "12" | "24"
  showDate: boolean
  showSeconds: boolean
  showDay: boolean
  timezone: string
  language: string
}

/** Reloj TV: hora + fecha + día, se actualiza cada segundo de forma sutil. */
export default function Clock({ clockFormat, showDate, showSeconds, showDay, timezone, language }: ClockProps) {
  const [now, setNow] = useState<Date>(new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const hour12 = clockFormat !== "24"
  const locale = language === "es" ? "es-ES" : language

  const timeStr = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
    hour12,
    timeZone: timezone,
  }).format(now)

  const dayStr = showDay
    ? new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: timezone }).format(now).toUpperCase()
    : null

  const dateStr = showDate
    ? new Intl.DateTimeFormat(locale, {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: timezone,
      })
        .format(now)
        .toUpperCase()
    : null

  return (
    <div className="flex flex-col justify-center" aria-label="Fecha y hora actual">
      {dayStr && (
        <span
          className="tv-font-display leading-none font-bold"
          style={{ fontSize: "calc(2.1vh * var(--fscale, 1))", color: "var(--tv-primary)" }}
        >
          {dayStr}
        </span>
      )}
      {dateStr && (
        <span
          className="tv-font-display leading-tight text-white/70"
          style={{ fontSize: "calc(1.7vh * var(--fscale, 1))", letterSpacing: "0.06em" }}
        >
          {dateStr}
        </span>
      )}
      <span
        className="tv-font-display leading-none text-white"
        style={{ fontSize: "calc(4.3vh * var(--fscale, 1))", letterSpacing: "0.03em" }}
      >
        {timeStr}
      </span>
    </div>
  )
}
