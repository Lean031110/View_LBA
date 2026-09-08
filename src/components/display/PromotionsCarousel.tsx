"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import type { PromotionDTO } from "@/lib/types"

/** OFERTAS Y PROMOCIONES — carrusel automático con transiciones suaves. */
export default function PromotionsCarousel({
  promotions,
  animationsEnabled,
  animationSpeed,
}: {
  promotions: PromotionDTO[]
  animationsEnabled: boolean
  animationSpeed: number
}) {
  const [index, setIndex] = useState(0)

  // Reset del índice cuando cambia la lista (realtime) — ajuste en render, patrón React
  const promoKey = promotions.map((p) => p.id).join(",")
  const [prevKey, setPrevKey] = useState(promoKey)
  if (promoKey !== prevKey) {
    setPrevKey(promoKey)
    setIndex(0)
  }

  const current = promotions[index % Math.max(promotions.length, 1)]

  useEffect(() => {
    if (!current || promotions.length <= 1) return
    const seconds = Math.max(4, current.duration || 10) / Math.max(animationSpeed, 0.25)
    const id = setInterval(() => setIndex((i) => (i + 1) % promotions.length), seconds * 1000)
    return () => clearInterval(id)
  }, [current, promotions.length, animationSpeed])

  if (promotions.length === 0) return null

  return (
    <section
      className="flex flex-col min-h-0 rounded-[1.2vh] border border-white/10 overflow-hidden"
      style={{ background: "color-mix(in srgb, var(--tv-surface) 92%, transparent)" }}
      aria-label="Ofertas y promociones"
    >
      {/* Encabezado */}
      <div className="flex items-center gap-[0.7vw] px-[1.2vw] pt-[1.1vh] pb-[0.7vh] shrink-0">
        <span className="w-[0.35vw] min-w-4px h-[2.2vh] rounded-full" style={{ background: "var(--tv-primary)" }} />
        <h2
          className="tv-font-display text-white"
          style={{ fontSize: "calc(2.5vh * var(--fscale, 1))", letterSpacing: "0.1em" }}
        >
          OFERTAS Y PROMOCIONES
        </h2>
      </div>

      {/* Contenido del carrusel */}
      <div className="relative flex-1 min-h-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            initial={animationsEnabled ? { opacity: 0, x: "-3%" } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={animationsEnabled ? { opacity: 0, x: "3%" } : undefined}
            transition={{ duration: 0.65 / Math.max(animationSpeed, 0.25), ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex"
          >
            {/* Imagen */}
            {current.imageUrl && (
              <div className="relative w-[42%] shrink-0 overflow-hidden">
                <img
                  src={current.imageUrl}
                  alt={current.title}
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
                <div
                  className="absolute inset-0"
                  style={{ background: "linear-gradient(to right, transparent 55%, var(--tv-surface) 100%)" }}
                />
              </div>
            )}
            {/* Texto */}
            <div className="flex-1 flex flex-col justify-center min-w-0 px-[1.3vw] py-[1vh] gap-[0.6vh]">
              {current.badge && (
                <span
                  className="self-start tv-font-display rounded-[0.5vh] px-[0.8vw] py-[0.2vh]"
                  style={{
                    fontSize: "calc(1.6vh * var(--fscale, 1))",
                    letterSpacing: "0.12em",
                    background: "var(--tv-primary)",
                    color: "#221507",
                  }}
                >
                  {current.badge}
                </span>
              )}
              <h3
                className="tv-font-display text-white leading-[0.95] break-words"
                style={{ fontSize: "calc(5.2vh * var(--fscale, 1))" }}
              >
                {current.title}
              </h3>
              {current.description && (
                <p
                  className="font-medium text-white/65 leading-snug line-clamp-3"
                  style={{ fontSize: "calc(1.75vh * var(--fscale, 1))" }}
                >
                  {current.description}
                </p>
              )}
              <div className="flex items-baseline gap-[0.8vw] flex-wrap mt-[0.3vh]">
                {current.price && (
                  <span
                    className="tv-font-display leading-none"
                    style={{ fontSize: "calc(4.6vh * var(--fscale, 1))", color: "var(--tv-primary)" }}
                  >
                    {current.price}
                  </span>
                )}
                {current.oldPrice && (
                  <span
                    className="tv-font-display text-white/45"
                    style={{
                      fontSize: "calc(2.6vh * var(--fscale, 1))",
                      textDecoration: "line-through",
                      textDecorationColor: "var(--tv-accent)",
                      textDecorationThickness: "0.25vh",
                    }}
                  >
                    {current.oldPrice}
                  </span>
                )}
                {current.discount && (
                  <span
                    className="tv-font-display rounded-[0.5vh] px-[0.7vw] leading-tight"
                    style={{
                      fontSize: "calc(2.1vh * var(--fscale, 1))",
                      background: "var(--tv-accent)",
                      color: "#fff",
                    }}
                  >
                    {current.discount}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Indicadores */}
      {promotions.length > 1 && (
        <div className="flex items-center justify-center gap-[0.5vw] pt-[0.4vh] pb-[0.9vh] shrink-0">
          {promotions.map((p, i) => (
            <button
              key={p.id}
              onClick={() => setIndex(i)}
              aria-label={`Promoción ${i + 1}`}
              className="rounded-full transition-all duration-500 h-[0.55vh]"
              style={{
                width: i === index ? "calc(1.8vw * var(--fscale,1))" : "calc(0.55vh)",
                background: i === index ? "var(--tv-primary)" : "rgba(255,255,255,0.25)",
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}
