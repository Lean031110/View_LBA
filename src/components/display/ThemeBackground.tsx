"use client"

import { memo } from "react"
import type { PublicTheme } from "@/lib/types"

/**
 * FONDO DECORATIVO DEL TEMA — capa declarativa renderizada por el MOTOR
 * (§9/§13: un tema NUNCA incluye código ni CSS; el motor interpreta).
 *
 * Se pinta DETRÁS del contenido (z-index -1 dentro del stacking context de
 * .tv-root) y es puramente estética: pointer-events none, sin interacción,
 * animaciones GPU (transform/opacity/filter) seguras para 24/7.
 *
 * Efectos: none | gradient | grid | glow (+ imagen de fondo opcional).
 */
function ThemeBackgroundImpl({ theme, animationsEnabled }: { theme: PublicTheme | null; animationsEnabled: boolean }) {
  if (!theme) return null
  const effect = theme.spec.background.effect
  const bgImage = theme.backgroundImageUrl

  // Default puro (efecto none + sin imagen de fondo): ni montamos la capa
  if (effect === "none" && !bgImage) return null

  return (
    <div
      className={`tv-theme-bg${effect !== "none" ? ` tv-theme-bg-${effect}` : ""}${animationsEnabled ? "" : " tv-anim-off"}`}
      aria-hidden="true"
      data-theme-bg={effect}
    >
      {bgImage && (
        <img src={bgImage} alt="" draggable={false} className="tv-theme-bg-image" />
      )}
    </div>
  )
}

export default memo(ThemeBackgroundImpl)
