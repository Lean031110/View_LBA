"use client"

import { motion } from "framer-motion"
import type { SocialLinkDTO } from "@/lib/types"
import { SocialIcon } from "./SocialIcons"

/** Franja de redes sociales con micro-animaciones elegantes. */
export default function SocialLinks({
  socials,
  animationsEnabled,
}: {
  socials: SocialLinkDTO[]
  animationsEnabled: boolean
}) {
  if (socials.length === 0) return null

  return (
    <div
      className={`flex items-stretch justify-center gap-[1.1vw] px-[2vw] ${animationsEnabled ? "tv-social-anim" : ""}`}
      style={{ paddingBlock: "1.1vh" }}
      aria-label="Redes sociales"
    >
      {socials.map((s, i) => (
        <motion.div
          key={s.id}
          initial={animationsEnabled ? { opacity: 0, y: "1.5vh" } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: animationsEnabled ? 0.12 * i : 0, duration: 0.7, ease: "easeOut" }}
          whileHover={animationsEnabled ? { scale: 1.06, y: "-0.3vh" } : undefined}
          className="tv-social-card flex items-center gap-[0.7vw] rounded-[1vh] border border-white/10 px-[1.3vw]"
          style={{ background: "color-mix(in srgb, var(--tv-surface) 85%, transparent)", backdropFilter: "blur(6px)" }}
        >
          <span className="flex items-center justify-center shrink-0">
            <SocialIcon network={s.network} size="calc(2.9vh * var(--fscale, 1))" color={s.color} />
          </span>
          <div className="flex flex-col leading-tight min-w-0">
            <span
              className="tv-font-display text-white"
              style={{ fontSize: "calc(1.95vh * var(--fscale, 1))", letterSpacing: "0.08em" }}
            >
              {s.network}
            </span>
            {s.username && (
              <span
                className="font-medium text-white/60 truncate"
                style={{ fontSize: "calc(1.5vh * var(--fscale, 1))", maxWidth: "10vw" }}
              >
                {s.username}
              </span>
            )}
          </div>
        </motion.div>
      ))}
    </div>
  )
}
