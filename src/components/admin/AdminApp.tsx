"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { type Socket } from "socket.io-client"
import { connectSocket } from "@/lib/client-socket"
import {
  LayoutDashboard, Radio, Tag, ChefHat, Clock, Share2, Newspaper, Image as ImageIcon,
  Volume2, MonitorPlay, Palette, Users, ScrollText, LogOut, ExternalLink, ShieldCheck, Lock, AlertTriangle,
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
import ThemesSection from "./sections/ThemesSection"
import UsersSection from "./sections/UsersSection"
import LogsSection from "./sections/LogsSection"
import LicenseSection from "./sections/LicenseSection"
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
  { id: "dish", label: "Sugerencias del Día", icon: ChefHat, roles: ["ADMIN", "OPERATOR"] },
  { id: "schedules", label: "Horarios", icon: Clock, roles: ["ADMIN", "OPERATOR"] },
  { id: "socials", label: "Redes Sociales", icon: Share2, roles: ["ADMIN", "OPERATOR"] },
  { id: "ticker", label: "Ticker", icon: Newspaper, roles: ["ADMIN", "OPERATOR"] },
  { id: "branding", label: "Logotipo", icon: ImageIcon, roles: ["ADMIN", "OPERATOR"] },
  { id: "audio", label: "Audio", icon: Volume2, roles: ["ADMIN", "OPERATOR"] },
  { id: "screens", label: "Pantallas", icon: MonitorPlay, roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { id: "appearance", label: "Apariencia", icon: Palette, roles: ["ADMIN", "OPERATOR"] },
  // v3.1 THEMES: gestor de temas de pantalla (gated themes.custom — el
  // tema ACTIVO se sigue mostrando en TV; aquí se gestiona importar/aplicar)
  { id: "themes", label: "Temas de Pantalla", icon: Palette, roles: ["ADMIN", "OPERATOR"] },
  { id: "users", label: "Usuarios", icon: Users, roles: ["ADMIN"] },
  // FASE 4: auditoría sin VIEWER (el backend también exige OPERATOR+)
  { id: "logs", label: "Registros", icon: ScrollText, roles: ["ADMIN", "OPERATOR"] },
  // LICENSING: estado + importación (importar solo ADMIN dentro de la sección)
  { id: "license", label: "Licencia", icon: ShieldCheck, roles: ["ADMIN", "OPERATOR"] },
] as const

/** Secciones bloqueadas durante trial/limitado (mapeadas a flags REALES).
 *  OJO: «themes» NO está aquí — ThemesSection gestiona su propio candado
 *  interno (§17: durante el trial se VISUALIZA el gestor con el aviso
 *  «Los temas de pantalla están disponibles con una licencia completa»;
 *  el backend sigue rechazando importar/aplicar con 403). */
const PREMIUM_SECTIONS: Record<string, string> = {
  branding: "branding.customLogo",
  appearance: "themes.custom",
  users: "users.management",
}

/** Estado de licencia para el panel (banner + gating de premium). */
export interface LicensePanelInfo {
  status: "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"
  daysLeft: number
  features: Record<string, boolean>
  contact: string
}

export default function AdminApp() {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [section, setSection] = useState<string>("dashboard")
  const [screensStatus, setScreensStatus] = useState<ScreenStatus[]>([])
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const [streamServer, setStreamServer] = useState<StreamServerStatus | null>(null)
  const [license, setLicense] = useState<LicensePanelInfo | null>(null)
  const socketRef = useRef<Socket | null>(null)

  // Verificar sesión existente
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  // LICENSING: estado para banner de trial + gating premium (refresco al
  // volver a la sección Licencia y cada 60s — barato: cache 3s en backend)
  const loadLicense = useCallback(() => {
    fetch("/api/license")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setLicense(
          d && d.status
          ? { status: d.status, daysLeft: d.daysLeft ?? 0, features: d.features ?? {}, contact: d.contact ?? "52973387" }
          : null
        )
      )
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!user) return
    loadLicense()
    const t = setInterval(loadLicense, 60_000)
    return () => clearInterval(t)
  }, [user, loadLicense, section])

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
  const props = { user, screensStatus, realtimeConnected, sendCommand, section, setSection, streamServer, license }

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
    themes: ThemesSection,
    users: UsersSection,
    logs: LogsSection,
    license: LicenseSection,
  } as unknown as Record<string, React.ComponentType<typeof props>>
  const CurrentSection = SECTION_COMPONENTS[section] ?? Dashboard

  // Gating premium (secciones reales bloqueadas en trial/limitado)
  const lockedFeature = PREMIUM_SECTIONS[section]
  const sectionLocked = !!lockedFeature && license !== null && license.features[lockedFeature] !== true

  const banner = licenseBanner(license)

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
            const featureKey = PREMIUM_SECTIONS[s.id]
            const locked = !!featureKey && license !== null && license.features[featureKey] !== true
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active ? "bg-amber-500/12 text-amber-300" : "text-white/60 hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon size={17} className={active ? "text-amber-400" : ""} />
                <span className="flex-1 text-left">{s.label}</span>
                {locked && <Lock size={12} className="text-amber-400/50 shrink-0" aria-label="Requiere licencia" />}
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
        {/* Banner de licencia (trial / limitado) — nunca con licencia activa */}
        {banner && (
          <div className={`flex items-center gap-3 px-5 py-2.5 text-sm border-b ${banner.tone}`}>
            <AlertTriangle size={15} className="shrink-0" />
            <span className="flex-1">{banner.text}</span>
            <button onClick={() => setSection("license")} className="shrink-0 rounded-md bg-white/10 hover:bg-white/20 px-3 py-1 text-xs font-semibold text-white transition-colors">
              Ir a Licencia
            </button>
          </div>
        )}
        {sectionLocked ? <PremiumLocked notice={license!.status === "trial" ? "función premium" : "licencia requerida"} /> : <CurrentSection {...props} />}
      </main>
    </div>
  )
}

/** Texto del banner según el estado de licencia. */
function licenseBanner(license: LicensePanelInfo | null): { text: string; tone: string } | null {
  if (!license) return null
  switch (license.status) {
    case "active":
    case "grace":
      return null
    case "trial":
      return {
        text: `Versión de prueba — ${license.daysLeft > 1 ? `quedan ${license.daysLeft} días` : license.daysLeft === 1 ? "queda 1 día" : "último día"}. Las funciones premium se activan con tu licencia.`,
        tone: "bg-amber-500/10 text-amber-200 border-amber-500/25",
      }
    case "unlicensed":
      return {
        text: `Período de prueba finalizado — para continuar, activa tu licencia. Contacto: ${license.contact}.`,
        tone: "bg-red-500/10 text-red-300 border-red-500/25",
      }
    case "expired":
      return {
        text: `Licencia vencida — renueva para recuperar todas las funciones. Contacto: ${license.contact}.`,
        tone: "bg-orange-500/10 text-orange-300 border-orange-500/25",
      }
    case "mismatch":
      return {
        text: `La licencia está vinculada a otro equipo/disco. Contacto: ${license.contact}.`,
        tone: "bg-red-500/10 text-red-300 border-red-500/25",
      }
    default:
      return {
        text: `Licencia no válida. Importa una licencia emitida para este equipo. Contacto: ${license.contact}.`,
        tone: "bg-red-500/10 text-red-300 border-red-500/25",
      }
  }
}

/** Panel de sección bloqueada por licencia (premium). */
function PremiumLocked({ notice }: { notice: string }) {
  return (
    <div className="p-6 max-w-3xl">
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-10 text-center space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/15 flex items-center justify-center mx-auto">
          <Lock size={26} className="text-amber-400" />
        </div>
        <h2 className="text-xl font-bold text-white">{notice === "función premium" ? "Función disponible en el plan comercial" : "Requiere licencia comercial"}</h2>
        <p className="text-sm text-white/50 max-w-md mx-auto leading-relaxed">
          Esta sección se habilita con una licencia <span className="text-amber-300 font-semibold">Mensual (USD 10)</span> o{" "}
          <span className="text-amber-300 font-semibold">Anual (USD 100)</span>. El resto del sistema — contenido, transmisión y pantalla TV — sigue funcionando con normalidad.
        </p>
        <p className="text-sm text-amber-300 font-semibold">52973387</p>
      </div>
    </div>
  )
}
