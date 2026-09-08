"use client"

import { motion } from "framer-motion"
import { ChefHat, Flame } from "lucide-react"
import type { DishDTO } from "@/lib/types"

/** SUGERENCIA DEL DÍA — plato recomendado con imagen, descripción y precio. */
export default function DishOfTheDay({
  dish,
  animationsEnabled,
  animationSpeed,
}: {
  dish: DishDTO | null
  animationsEnabled: boolean
  animationSpeed: number
}) {
  if (!dish) return null

  return (
    <motion.section
      initial={animationsEnabled ? { opacity: 0, y: "2vh" } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7 / Math.max(animationSpeed, 0.25), delay: animationsEnabled ? 0.25 : 0 }}
      className="flex flex-col min-h-0 flex-1 rounded-[1.2vh] border border-white/10 overflow-hidden"
      style={{ background: "color-mix(in srgb, var(--tv-surface) 92%, transparent)" }}
      aria-label="Sugerencia del día"
    >
      <div className="flex items-center gap-[0.7vw] px-[1.2vw] pt-[1.1vh] pb-[0.7vh] shrink-0">
        <ChefHat size="calc(2.1vh * var(--fscale, 1))" style={{ color: "var(--tv-primary)" }} />
        <h2
          className="tv-font-display text-white"
          style={{ fontSize: "calc(2.5vh * var(--fscale, 1))", letterSpacing: "0.1em" }}
        >
          SUGERENCIA DEL DÍA
        </h2>
      </div>

      <div className="flex flex-1 min-h-0 gap-[1vw] px-[1.2vw] pb-[1.1vh]">
        {dish.imageUrl && (
          <div className="relative w-[34%] shrink-0 rounded-[0.9vh] overflow-hidden">
            <img src={dish.imageUrl} alt={dish.name} className="absolute inset-0 w-full h-full object-cover" draggable={false} />
            {dish.tag && (
              <span
                className="absolute top-[0.7vh] left-[0.7vh] tv-font-display rounded-[0.5vh] px-[0.65vw] py-[0.15vh] flex items-center gap-[0.3vw]"
                style={{ fontSize: "calc(1.45vh * var(--fscale, 1))", background: "var(--tv-accent)", color: "#fff", letterSpacing: "0.08em" }}
              >
                <Flame size="calc(1.45vh * var(--fscale, 1))" /> {dish.tag}
              </span>
            )}
          </div>
        )}
        <div className="flex-1 flex flex-col justify-center min-w-0 gap-[0.5vh]">
          <h3
            className="tv-font-display text-white leading-[0.95] break-words"
            style={{ fontSize: "calc(3.6vh * var(--fscale, 1))" }}
          >
            {dish.name}
          </h3>
          {dish.description && (
            <p className="font-medium text-white/65 leading-snug line-clamp-3" style={{ fontSize: "calc(1.65vh * var(--fscale, 1))" }}>
              {dish.description}
            </p>
          )}
          {dish.ingredients && (
            <p className="text-white/40 leading-tight line-clamp-2" style={{ fontSize: "calc(1.35vh * var(--fscale, 1))" }}>
              {dish.ingredients}
            </p>
          )}
          {dish.price && (
            <span
              className="tv-font-display leading-none mt-[0.2vh]"
              style={{ fontSize: "calc(3.8vh * var(--fscale, 1))", color: "var(--tv-primary)" }}
            >
              {dish.price}
            </span>
          )}
        </div>
      </div>
    </motion.section>
  )
}
