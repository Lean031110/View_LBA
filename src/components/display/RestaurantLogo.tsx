"use client"

/** Logo del restaurante (o marca tipográfica si no hay logo). */
export default function RestaurantLogo({
  logoUrl,
  restaurantName,
  size = "md",
}: {
  logoUrl: string | null
  restaurantName: string
  size?: string
}) {
  const heights: Record<string, string> = {
    sm: "calc(5.5vh * var(--fscale, 1))",
    md: "calc(8.5vh * var(--fscale, 1))",
    lg: "calc(12vh * var(--fscale, 1))",
  }
  const h = heights[size] ?? heights.md

  if (logoUrl) {
    return (
      <div className="flex items-center justify-center" style={{ height: h, minWidth: `calc(${h} * 1.6)` }} aria-label={restaurantName}>
        <img
          src={logoUrl}
          alt={restaurantName}
          style={{ height: "100%", maxWidth: "calc(16vw * var(--fscale, 1))", objectFit: "contain", filter: "drop-shadow(0 0.4vh 1vh rgba(0,0,0,0.5))" }}
          draggable={false}
        />
      </div>
    )
  }

  // Marca tipográfica premium
  return (
    <div className="flex flex-col items-end justify-center leading-none select-none" aria-label={restaurantName}>
      <span
        className="tv-font-display text-white"
        style={{ fontSize: "calc(4vh * var(--fscale, 1))", letterSpacing: "0.05em", lineHeight: 1 }}
      >
        {restaurantName.toUpperCase()}
      </span>
      <span
        className="tv-font-display"
        style={{ fontSize: "calc(1.3vh * var(--fscale, 1))", color: "var(--tv-primary)", letterSpacing: "0.5em", marginTop: "0.5vh" }}
      >
        GRILL &amp; BAR
      </span>
    </div>
  )
}
