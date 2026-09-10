"use client"

/**
 * Watermark de licencia para la pantalla TV (sección 13).
 *
 *  · Visible SOLO durante trial / estados limitados (nunca con licencia activa).
 *  · Discreta: esquina inferior, pointer-events-none, sin interferir con el
 *    vídeo ni la UI (overlay puro).
 *  · NO aparece en administración (este componente solo se usa en TvDisplay).
 */
export default function TrialWatermark({ visible, lines }: { visible: boolean; lines: string[] | null }) {
  if (!visible || !lines || lines.length === 0) return null

  return (
    <div
      aria-hidden="true"
      className="fixed left-[1.2vw] bottom-[10.5vh] z-30 pointer-events-none select-none rounded-lg border border-white/10 bg-black/35 px-[1vw] py-[0.8vh] backdrop-blur-[2px]"
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={`tv-font-display tracking-widest whitespace-nowrap ${i === 0 ? "text-amber-300/90 font-bold" : "text-white/70"}`}
          style={{ fontSize: `calc(${i === 0 ? 1.35 : 1.1}vh * var(--fscale, 1))` }}
        >
          {line}
        </div>
      ))}
    </div>
  )
}
