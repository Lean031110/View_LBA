"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { type Socket } from "socket.io-client"
import { connectSocket } from "@/lib/client-socket"
import {
  LayoutDashboard, Radio, Tag, ChefHat, Clock, Share2, Newspaper, Image as ImageIcon,
  Volume2, MonitorPlay, Palette, Users, ScrollText, LogOut, ExternalLink,
} from "lucide-react"
import LoginScreen from "./LoginScreen"
import Dashboard from "./sections/Dashboard"
import StreamSection from "./sections/StreamSection"
import PromotionsSection from "./sections/PromotionsSection"
import DishSection from "./sections/DishSection"
import SchedulesSection from "./sections/SchedulesSection"
import SocialsSection from "./sections/SocialsSection"
import TickerSection from "./sections/TickerSection"
import BrandingSection from "./sections/BrandingSection"
import AudioSection from "./sections/AudioSection"
import ScreensSection from "./sections/ScreensSection"
import AppearanceSection from "./sections/AppearanceSection"
import UsersSection from "./sections/UsersSection"
import LogsSection from "./sections/LogsSection"
import type { ScreenStatus } from "@/lib/types"
import { APP_NAME, APP_LOGO_MARK } from "@/lib/brand"

/** Estado del servidor de transmisión RTMP integrado (LAN) */
export interface StreamServerStatus {
  source: "local" | "external"
  live: boolean
  since?: number | null
  viewers?: number
  publisherIp?: string | null
  serverUptimeSec?: number
  ts?: number
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
}

const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { id: "stream", label: "Transmisión", icon: Radio, roles: ["ADMIN", "OPERATOR"] },
  { id: "promotions", label: "Promociones", icon: Tag, roles: ["ADMIN", "OPERATOR"] },
  { id: "dish", label: "Plato del Día", icon: ChefHat, roles: ["ADMIN", "OPERATOR"] },
  { id: "schedules", label: "Horarios", icon: Clock, roles: ["ADMIN", "OPERATOR"] },
  { id: "socials", label: "Redes Sociales", icon: Share2, roles: ["ADMIN", "OPERATOR"] },
  { id: "ticker", label: "Ticker", icon: Newspaper, roles: ["ADMIN", "OPERATOR"] },
  { id: "branding", label: "Logotipo", icon: ImageIcon, roles: ["ADMIN", "OPERATOR"] },
  { id: "audio", label: "Audio", icon: Volume2, roles: ["ADMIN", "OPERATOR"] },
  { id: "screens", label: "Pantallas", icon: MonitorPlay, roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { id: "appearance", label: "Apariencia", icon: Palette, roles: ["ADMIN", "OPERATOR"] },
  { id: "users", label: "Usuarios", icon: Users, roles: ["ADMIN"] },
  { id: "logs", label: "Registros", icon: ScrollText, roles: ["ADMIN", "OPERATOR", "VIEWER"] },
] as const

export default function AdminApp() {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [section, setSection] = useState<string>("dashboard")
  const [screensStatus, setScreensStatus] = useState<ScreenStatus[]>([])
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const [streamServer, setStreamServer] = useState<StreamServerStatus | null>(null)
  const socketRef = useRef<Socket | null>(null)

  // Verificar sesión existente
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  // Conexión realtime del panel (estado de pantallas + stream)
  useEffect(() => {
    if (!user) return
    const socket = connectSocket()
    socketRef.current = socket

    socket.on("connect", () => {
      setRealtimeConnected(true)
      socket.emit("admin:register")
    })
    socket.on("disconnect", () => setRealtimeConnected(false))
    socket.on("screens:snapshot", (data: { screens: ScreenStatus[] }) => {
      setScreensStatus(data.screens ?? [])
    })
    socket.on("stream:status", (data: { screenCode: string } & Partial<ScreenStatus>) => {
      setScreensStatus((prev) => prev.map((s) => (s.screenCode === data.screenCode ? { ...s, ...data, online: true } : s)))
    })

    // Estado del servidor RTMP integrado (OBS conectado/desconectado, viewers)
    socket.on("stream:server", (d: StreamServerStatus) => {
      if (d && typeof d.live === "boolean") setStreamServer(d)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user])

  const sendCommand = useCallback((type: string, payload?: Record<string, unknown>, screenCode?: string) => {
    socketRef.current?.emit("admin:command", { type, payload, screenCode })
  }, [])

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {})
    setUser(null)
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0c0c10]">
        <div className="w-12 h-12 rounded-full border-4 border-white/10 border-t-amber-400 animate-spin" />
      </div>
    )
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />
  }

  const visibleSections = SECTIONS.filter((s) => s.roles.includes(user.role as never))
  const props = { user, screensStatus, realtimeConnected, sendCommand, section, setSection, streamServer }

  const SECTION_COMPONENTS = {
    dashboard: Dashboard,
    stream: StreamSection,
    promotions: PromotionsSection,
    dish: DishSection,
    schedules: SchedulesSection,
    socials: SocialsSection,
    ticker: TickerSection,
    branding: BrandingSection,
    audio: AudioSection,
    screens: ScreensSection,
    appearance: AppearanceSection,
    users: UsersSection,
    logs: LogsSection,
  } as unknown as Record<string, React.ComponentType<typeof props>>
  const CurrentSection = SECTION_COMPONENTS[section] ?? Dashboard

  return (
    <div className="min-h-screen flex" style={{ background: "#0c0c10" }}>
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-white/8 flex flex-col sticky top-0 h-screen" style={{ background: "#101016" }}>
        <div className="p-5 pb-4 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            { }
            <img src={APP_LOGO_MARK} alt={APP_NAME} className="w-9 h-9 rounded-xl shrink-0" draggable={false} />
            <div className="min-w-0">
              <div className="text-white font-bold text-sm leading-tight">{APP_NAME}</div>
              <div className="text-white/35 text-[11px]">Administración</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto custom-scrollbar py-3 px-3 space-y-0.5">
          {visibleSections.map((s) => {
            const Icon = s.icon
            const active = section === s.id
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active ? "bg-amber-500/12 text-amber-300" : "text-white/60 hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon size={17} className={active ? "text-amber-400" : ""} />
                {s.label}
              </button>
            )
          })}
        </nav>

        <div className="p-4 border-t border-white/8 space-y-2">
          <Link
            href="/?view=tv"
            target="_blank"
            className="flex items-center justify-center gap-2 w-full rounded-lg border border-white/12 py-2 text-sm font-medium text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ExternalLink size={14} /> Ver pantalla TV
          </Link>
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-8 h-8 rounded-full bg-white/8 flex items-center justify-center text-xs font-bold text-amber-300 shrink-0">
              {user.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-white/85 text-xs font-semibold truncate">{user.name}</div>
              <div className="text-white/35 text-[10px] uppercase">{user.role}</div>
            </div>
            <button onClick={logout} className="p-1.5 rounded-md text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Cerrar sesión">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 min-w-0 overflow-x-hidden">
        <CurrentSection {...props} />
      </main>
    </div>
  )
}
