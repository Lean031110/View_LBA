"use client"

import { useEffect, useRef, useState } from "react"

/** TICKER — franja con texto en movimiento continuo (izquierda → derecha). */
export default function NewsTicker({
  messages,
  speed = 55, // px por segundo
  paused = false,
  restaurantName,
  themeStyle = "classic",
}: {
  messages: string[]
  speed?: number
  paused?: boolean
  restaurantName?: string
  /** v3.1 THEMES: estilo del ticker (classic | neon). */
  themeStyle?: "classic" | "neon"
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(40)
  const contentKey = messages.join("‖")

  // Calcular duración según ancho real del contenido → velocidad constante
  useEffect(() => {
    const measure = () => {
      const track = trackRef.current
      if (!track) return
      // El track contiene 2 copias; ancho de una copia = scrollWidth / 2
      const copyWidth = track.scrollWidth / 2
      if (copyWidth > 0) {
        const seconds = Math.max(12, copyWidth / Math.max(speed, 10))
        setDuration(seconds)
      }
    }
    measure()
    const id = setInterval(measure, 5000) // re-medir (fuentes/imágenes tardías)
    window.addEventListener("resize", measure)
    return () => {
      clearInterval(id)
      window.removeEventListener("resize", measure)
    }
  }, [contentKey, speed])

  if (messages.length === 0) return null

  const renderCopy = () => (
    <>
      {messages.map((m, i) => (
        <span key={i} className="inline-flex items-center">
          <span
            className="tv-font-display font-medium"
            style={{ fontSize: "calc(2.5vh * var(--fscale, 1))", letterSpacing: "0.1em", paddingInline: "1.2vw" }}
          >
            {m}
          </span>
          <span
            aria-hidden
            style={{
              width: "0.8vh",
              height: "0.8vh",
              borderRadius: "50%",
              background: "var(--tv-primary)",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
        </span>
      ))}
    </>
  )

  return (
    <div
      className={`relative overflow-hidden ${themeStyle === "neon" ? "" : "bg-white"} tv-ticker-${themeStyle} ${paused ? "tv-ticker-paused" : ""}`}
      style={{
        height: "calc(4.6vh * var(--fscale, 1))",
        minHeight: "30px",
        background: themeStyle === "neon" ? "color-mix(in srgb, var(--tv-bg) 88%, #000)" : undefined,
      }}
      role="marquee"
      aria-label="Información en movimiento"
    >
      {/* Etiqueta fija a la izquierda */}
      {restaurantName && (
        <div
          className="absolute inset-y-0 left-0 z-10 flex items-center px-[1.2vw] tv-font-display shrink-0"
          style={{
            background: "var(--tv-primary)",
            color: themeStyle === "neon" ? "#05060e" : "#fff",
            fontSize: "calc(2vh * var(--fscale, 1))",
            letterSpacing: "0.12em",
            clipPath: "polygon(0 0, 100% 0, calc(100% - 1.2vh) 100%, 0 100%)",
            boxShadow: themeStyle === "neon" ? "0 0 1.6vh var(--tv-glow)" : undefined,
          }}
        >
          {restaurantName.toUpperCase()}
        </div>
      )}
      <div className="h-full flex items-center" style={{ paddingLeft: restaurantName ? "14vw" : 0 }}>
        <div
          ref={trackRef}
          className={`tv-ticker-track ${themeStyle === "neon" ? "text-white" : "text-neutral-900"}`}
          style={{
            ["--ticker-duration" as string]: `${duration}s`,
            background: themeStyle === "neon" ? "color-mix(in srgb, var(--tv-bg) 88%, #000)" : undefined,
          }}
        >
          <span className="inline-flex items-center">{renderCopy()}</span>
          <span className="inline-flex items-center" aria-hidden>
            {renderCopy()}
          </span>
        </div>
      </div>
    </div>
  )
}
