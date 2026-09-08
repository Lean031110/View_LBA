"use client"

import { motion } from "framer-motion"
import type { SocialLinkDTO } from "@/lib/types"
import { SocialIcon, brandGradient, SOCIAL_NETWORKS } from "./SocialIcons"

/** Destello de 4 puntas (SVG puro, sin fuentes) */
function Sparkle({ color, delay }: { color: string; delay: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="tv-sparkle"
      style={{ color, animationDelay: `${delay}s`, width: "calc(1.3vh * var(--fscale, 1))", height: "calc(1.3vh * var(--fscale, 1))", minWidth: 8, minHeight: 8 }}
    >
      <path
        d="M12 0l2.4 9.6L24 12l-9.6 2.4L12 24l-2.4-9.6L0 12l9.6-2.4z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Franja social compacta y profesional: Facebook · Instagram · WhatsApp
 *  con destellos y movimiento sutil (shine + float + glow). */
export default function SocialLinks({
  socials,
  animationsEnabled,
}: {
  socials: SocialLinkDTO[]
  animationsEnabled: boolean
}) {
  // Solo las redes permitidas (YouTube/TikTok fuera por ahora)
  const allowed = new Set<string>(SOCIAL_NETWORKS)
  const visible = socials.filter((s) => allowed.has(s.network?.toUpperCase()))

  if (visible.length === 0) return null

  return (
    <div
      className={`flex items-center justify-center gap-[0.9vw] px-[2vw] ${animationsEnabled ? "tv-social-anim" : ""}`}
      style={{ paddingBlock: "0.55vh" }}
      aria-label="Redes sociales"
    >
      {visible.map((s, i) => {
        const net = s.network.toUpperCase()
        const gradient = brandGradient(net)
        return (
          <motion.div
            key={s.id}
            initial={animationsEnabled ? { opacity: 0, y: "1.2vh" } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: animationsEnabled ? 0.1 * i : 0, duration: 0.6, ease: "easeOut" }}
            whileHover={animationsEnabled ? { scale: 1.05, y: "-0.25vh" } : undefined}
            className="tv-social-card flex items-center gap-[0.55vw] rounded-[0.9vh] border border-white/10 pl-[0.55vw] pr-[1vw]"
            style={{
              background: "color-mix(in srgb, var(--tv-surface) 88%, transparent)",
              backdropFilter: "blur(6px)",
            }}
          >
            {/* Insignia circular con degradado de marca + destello */}
            <span
              className="tv-social-badge relative flex items-center justify-center shrink-0 rounded-full"
              style={{
                width: "calc(3.4vh * var(--fscale, 1))",
                height: "calc(3.4vh * var(--fscale, 1))",
                minWidth: 30,
                minHeight: 30,
                background: gradient ?? "color-mix(in srgb, var(--tv-primary) 70%, #000 30%)",
                boxShadow: "inset 0 -0.35vh 0.7vh rgba(0,0,0,0.28), inset 0 0.25vh 0.5vh rgba(255,255,255,0.22)",
              }}
            >
              <SocialIcon network={s.network} size="calc(1.85vh * var(--fscale, 1))" color="#fff" />
              {animationsEnabled && (
                <span className="absolute pointer-events-none" style={{ top: "calc(-0.45vh - 2px)", right: "calc(-0.45vh - 2px)" }}>
                  <Sparkle color="var(--tv-primary, #f5a623)" delay={i * 1.15} />
                </span>
              )}
            </span>

            {/* Usuario */}
            <div className="flex flex-col leading-[1.05] min-w-0">
              <span
                className="tv-font-display text-white/40"
                style={{ fontSize: "calc(1.15vh * var(--fscale, 1))", letterSpacing: "0.22em" }}
              >
                {s.network}
              </span>
              {s.username && (
                <span
                  className="font-semibold text-white/85 truncate"
                  style={{ fontSize: "calc(1.6vh * var(--fscale, 1))", maxWidth: "9vw" }}
                >
                  {s.username}
                </span>
              )}
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}
