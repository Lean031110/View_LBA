"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MonitorPlay, LayoutDashboard, Activity } from "lucide-react"
import type { ContentBundle } from "@/lib/types"
import { APP_NAME, APP_VERSION, APP_LOGO, APP_TAGLINE } from "@/lib/brand"

/** Pantalla de inicio: acceso a las dos aplicaciones (TV / Administración). */
export default function Launcher() {
  const [content, setContent] = useState<ContentBundle | null>(null)
  const [backendOk, setBackendOk] = useState<boolean | null>(null)

  useEffect(() => {
    fetch("/api/content")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setContent(d as ContentBundle)
        setBackendOk(Boolean(d))
      })
      .catch(() => setBackendOk(false))
  }, [])

  const name = content?.settings.restaurantName ?? "Restaurante"

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "radial-gradient(1200px 600px at 70% -10%, #1d1d28 0%, #0b0b0f 55%)" }}>
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-10">
        {/* Marca */}
        <div className="mb-4 flex flex-col items-center">
          { }
          <img src={APP_LOGO} alt={`${APP_NAME} — ${APP_TAGLINE}`} className="h-16 w-auto mb-2" draggable={false} />
        </div>
        <p className="text-white/50 mb-10 text-center max-w-md">
          Plataforma de pantallas para <span className="text-amber-300 font-semibold">{name}</span> — transmisión en
          vivo, promociones y contenido en tiempo real.
        </p>

        {/* Tarjetas de acceso */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-3xl">
          <Link
            href="/?view=tv"
            className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-7 transition-all hover:border-amber-400/50 hover:bg-amber-400/[0.06]"
          >
            <div className="absolute -right-6 -top-6 w-32 h-32 rounded-full bg-amber-500/10 blur-2xl transition-all group-hover:bg-amber-500/20" />
            <MonitorPlay size={34} className="text-amber-400 mb-4" />
            <h2 className="text-xl font-bold text-white mb-1.5">Pantalla TV</h2>
            <p className="text-sm text-white/50 leading-relaxed mb-5">
              Interfaz para televisores y monitores: transmisión en vivo, promociones, plato del día y ticker. Modo
              kiosco 24/7.
            </p>
            <span className="text-amber-300 text-sm font-semibold group-hover:translate-x-1 transition-transform inline-block">
              Abrir pantalla →
            </span>
          </Link>

          <Link
            href="/?view=admin"
            className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-7 transition-all hover:border-white/40 hover:bg-white/[0.06]"
          >
            <div className="absolute -right-6 -top-6 w-32 h-32 rounded-full bg-white/5 blur-2xl transition-all group-hover:bg-white/10" />
            <LayoutDashboard size={34} className="text-white/80 mb-4" />
            <h2 className="text-xl font-bold text-white mb-1.5">Administración</h2>
            <p className="text-sm text-white/50 leading-relaxed mb-5">
              Control total de la plataforma: transmisión, promociones, pantallas, usuarios, audio y configuración
              visual.
            </p>
            <span className="text-white/80 text-sm font-semibold group-hover:translate-x-1 transition-transform inline-block">
              Iniciar sesión →
            </span>
          </Link>
        </div>

        {/* Estado del sistema */}
        <div className="mt-12 flex items-center gap-6 text-xs text-white/40">
          <span className="flex items-center gap-1.5">
            <Activity size={13} className={backendOk === null ? "text-white/30" : backendOk ? "text-emerald-400" : "text-red-400"} />
            Backend {backendOk === null ? "…" : backendOk ? "operativo" : "sin conexión"}
          </span>
          {content && (
            <span className="flex items-center gap-1.5">
              <MonitorPlay size={13} className="text-white/30" />
              {content.promotions.length} promociones · {content.screens.length} pantallas
            </span>
          )}
        </div>
      </main>

      <footer className="mt-auto py-5 text-center text-xs text-white/25">
        {APP_NAME} v{APP_VERSION} · Live Streaming · Digital Signage
      </footer>
    </div>
  )
}
