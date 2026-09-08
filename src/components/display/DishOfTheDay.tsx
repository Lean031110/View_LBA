"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChefHat, Flame } from "lucide-react"
import type { DishDTO } from "@/lib/types"

/** SUGERENCIAS DEL DÍA — banner compacto; con varias sugerencias rota solo en bucle. */
export default function DishOfTheDay({
  dishes,
  animationsEnabled,
  animationSpeed,
}: {
  dishes: DishDTO[]
  animationsEnabled: boolean
  animationSpeed: number
}) {
  const [index, setIndex] = useState(0)

  // Reset del índice cuando cambia la lista (realtime) — ajuste en render, patrón React
  const dishKey = dishes.map((d) => d.id).join(",")
  const [prevKey, setPrevKey] = useState(dishKey)
  if (dishKey !== prevKey) {
    setPrevKey(dishKey)
    setIndex(0)
  }

  const current = dishes[index % Math.max(dishes.length, 1)]

  // Auto-slide en bucle cuando hay más de una sugerencia
  useEffect(() => {
    if (dishes.length <= 1) return
    const seconds = 7 / Math.max(animationSpeed, 0.25)
    const id = setInterval(() => setIndex((i) => (i + 1) % dishes.length), seconds * 1000)
    return () => clearInterval(id)
  }, [dishes.length, animationSpeed])

  if (dishes.length === 0) return null

  return (
    <motion.section
      initial={animationsEnabled ? { opacity: 0, y: "1.5vh" } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7 / Math.max(animationSpeed, 0.25), delay: animationsEnabled ? 0.25 : 0 }}
      className="relative shrink-0 rounded-[1.2vh] border border-white/10 overflow-hidden"
      style={{ background: "color-mix(in srgb, var(--tv-surface) 92%, transparent)" }}
      aria-label="Sugerencias del día"
    >
      <div className="relative" style={{ height: "calc(10.5vh * var(--fscale, 1))", minHeight: 74 }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            initial={animationsEnabled && dishes.length > 1 ? { opacity: 0, x: "-4%" } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={animationsEnabled && dishes.length > 1 ? { opacity: 0, x: "4%" } : undefined}
            transition={{ duration: 0.55 / Math.max(animationSpeed, 0.25), ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex items-stretch gap-[1vw] px-[1.1vw]"
          >
            {/* Imagen compacta */}
            {current.imageUrl && (
              <div className="relative self-center shrink-0 rounded-[0.8vh] overflow-hidden"
                style={{ width: "calc(8.2vh * var(--fscale, 1))", height: "calc(8.2vh * var(--fscale, 1))", minHeight: 56, minWidth: 56 }}>
                <img src={current.imageUrl} alt={current.name} className="absolute inset-0 w-full h-full object-cover" draggable={false} />
              </div>
            )}

            {/* Texto */}
            <div className="flex-1 flex flex-col justify-center min-w-0 gap-[0.25vh] py-[0.9vh]">
              <div className="flex items-center gap-[0.55vw]">
                <ChefHat size="calc(1.7vh * var(--fscale, 1))" style={{ color: "var(--tv-primary)", minHeight: 12, minWidth: 12 }} />
                <span
                  className="tv-font-display text-white/55"
                  style={{ fontSize: "calc(1.5vh * var(--fscale, 1))", letterSpacing: "0.18em" }}
                >
                  SUGERENCIAS DEL DÍA
                </span>
                {current.tag && (
                  <span
                    className="tv-font-display flex items-center gap-[0.25vw] rounded-[0.4vh] px-[0.5vw]"
                    style={{ fontSize: "calc(1.25vh * var(--fscale, 1))", background: "var(--tv-accent)", color: "#fff", letterSpacing: "0.08em" }}
                  >
                    <Flame size="calc(1.25vh * var(--fscale, 1))" style={{ minHeight: 9, minWidth: 9 }} /> {current.tag}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-[0.8vw] min-w-0">
                <h3
                  className="tv-font-display text-white leading-none truncate"
                  style={{ fontSize: "calc(2.9vh * var(--fscale, 1))" }}
                >
                  {current.name}
                </h3>
                {current.price && (
                  <span
                    className="tv-font-display leading-none shrink-0"
                    style={{ fontSize: "calc(2.7vh * var(--fscale, 1))", color: "var(--tv-primary)" }}
                  >
                    {current.price}
                  </span>
                )}
              </div>
              {current.description && (
                <p className="font-medium text-white/55 leading-tight truncate" style={{ fontSize: "calc(1.45vh * var(--fscale, 1))" }}>
                  {current.description}
                </p>
              )}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Indicadores (solo con varias sugerencias) */}
        {dishes.length > 1 && (
          <div className="absolute right-[0.8vw] top-[0.7vh] flex items-center gap-[0.4vw] z-10">
            {dishes.map((d, i) => (
              <button
                key={d.id}
                onClick={() => setIndex(i)}
                aria-label={`Sugerencia ${i + 1}`}
                className="rounded-full transition-all duration-500 h-[0.5vh]"
                style={{
                  width: i === index ? "calc(1.4vw * var(--fscale,1))" : "calc(0.5vh)",
                  minWidth: 5,
                  background: i === index ? "var(--tv-primary)" : "rgba(255,255,255,0.25)",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </motion.section>
  )
}
