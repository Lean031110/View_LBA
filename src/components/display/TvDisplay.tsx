"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Maximize, Minimize, RefreshCw } from "lucide-react"
import type { Socket } from "socket.io-client"
import type { ContentBundle, PublicSettings } from "@/lib/types"
import { connectSocket } from "@/lib/client-socket"
import { APP_LOGO_MARK } from "@/lib/brand"
import Clock from "./Clock"
import DailySchedule from "./DailySchedule"
import RestaurantLogo from "./RestaurantLogo"
import PromotionsCarousel from "./PromotionsCarousel"
import DishOfTheDay from "./DishOfTheDay"
import StreamPlayer, { type StreamMetrics } from "./StreamPlayer"
import SocialLinks from "./SocialLinks"
import NewsTicker from "./NewsTicker"
import ScreenPicker from "./ScreenPicker"

const SCREEN_KEY = "signage.screenCode"
const SCREEN_CHOSEN_KEY = "signage.screenChosen"

/** ¿La promoción está dentro de su ventana de fecha/hora? */
function promoVisible(now: Date, p: ContentBundle["promotions"][number]): boolean {
  if (p.startDate && now < new Date(p.startDate)) return false
  if (p.endDate && now > new Date(p.endDate)) return false
  if (p.startTime || p.endTime) {
    const mins = now.getHours() * 60 + now.getMinutes()
    const toM = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
    if (p.startTime && mins < toM(p.startTime)) return false
    if (p.endTime && mins >= toM(p.endTime)) return false
  }
  return true
}

/** Sugerencias del día visibles hoy: fecha específica → día de semana → genéricas.
 *  Devuelve LISTA (varias sugerencias rotan en el banner con auto-slide). */
function pickDishes(now: Date, dishes: ContentBundle["dishes"]) {
  const today = now.getDay()
  const iso = now.toISOString().slice(0, 10)
  const byDate = dishes.filter((d) => d.date && d.date.slice(0, 10) === iso)
  const byDay = dishes.filter((d) => d.dayOfWeek === today && !d.date)
  const generic = dishes.filter((d) => d.dayOfWeek == null && !d.date)
  if (byDate.length > 0) return byDate
  if (byDay.length > 0) return byDay
  if (generic.length > 0) return generic
  return dishes.slice(0, 1)
}

/**
 * PANTALLA TV — Aplicación de señalización digital para televisores.
 * Layout responsive basado en proporciones (vh/vw/grid), modo kiosco,
 * actualización realtime vía WebSocket y watchdog de recuperación.
 */
export default function TvDisplay() {
  const [content, setContent] = useState<ContentBundle | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [backendOnline, setBackendOnline] = useState(true)
  const [screenCode, setScreenCode] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [cursorHidden, setCursorHidden] = useState(false)
  const [audioConfig, setAudioConfig] = useState<{ volume: number; muted: boolean; deviceId: string | null } | null>(null)
  const [serverLive, setServerLive] = useState<boolean | null>(null) // estado del servidor RTMP local (OBS)
  const [isFullscreen, setIsFullscreen] = useState(false) // la marca ViewLBA solo se muestra fuera de pantalla completa
  const socketRef = useRef<Socket | null>(null)
  const failCountRef = useRef(0)
  const metricsRef = useRef<StreamMetrics | null>(null)

  // ---------- Carga de contenido ----------
  const fetchContent = useCallback(async () => {
    try {
      const res = await fetch("/api/content", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = (await res.json()) as ContentBundle
      setContent(data)
      setLoadError(false)
      setBackendOnline(true)
      failCountRef.current = 0
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem(SCREEN_KEY)
    setScreenCode(stored)
    // Primera visita en este dispositivo → identificar la pantalla
    if (!localStorage.getItem(SCREEN_CHOSEN_KEY)) setShowPicker(true)
    fetchContent()
  }, [fetchContent])

  // ---------- Realtime: cambios instantáneos desde administración ----------
  useEffect(() => {
    const socket = connectSocket()
    socketRef.current = socket

    socket.on("connect", () => {
      socket.emit("screen:register", {
        screenCode: localStorage.getItem(SCREEN_KEY) ?? "ANON",
        resolution: `${window.screen.width}×${window.screen.height}`,
        userAgent: navigator.userAgent.slice(0, 120),
      })
    })

    socket.on("content:update", () => fetchContent())

    // El servidor RTMP integrado avisa en tiempo real cuando OBS inicia/detiene
    socket.on("stream:server", (d: { source?: string; live?: boolean }) => {
      if (d?.source === "local") setServerLive(Boolean(d.live))
    })

    socket.on("audio:config", (cfg: { volume: number; muted: boolean; deviceId?: string | null }) => {
      setAudioConfig({ volume: cfg.volume, muted: cfg.muted, deviceId: cfg.deviceId ?? null })
    })

    socket.on("screen:command", (cmd: { type: string; payload?: Record<string, unknown> }) => {
      if (cmd.type === "reload") window.location.reload()
      if (cmd.type === "audio" && cmd.payload) {
        setAudioConfig({
          volume: Number(cmd.payload.volume ?? 80),
          muted: Boolean(cmd.payload.muted),
          deviceId: (cmd.payload.deviceId as string) ?? null,
        })
      }
    })

    // Heartbeat cada 15s → el panel admin ve esta pantalla ONLINE
    const hb = setInterval(() => {
      if (socket.connected) {
        socket.emit("screen:heartbeat", {
          resolution: `${window.innerWidth}×${window.innerHeight}`,
        })
      }
    }, 15_000)

    return () => {
      clearInterval(hb)
      socket.disconnect()
      socketRef.current = null
    }
  }, [fetchContent])

  // ---------- Estado del servidor de transmisión local (polling de respaldo) ----------
  // El evento socket 'stream:server' es la vía principal; este polling cada 10s
  // cubre caídas del websocket (pantalla 24/7 → tolerancia a fallos).
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch("/api/stream/status", { cache: "no-store" })
        if (!res.ok) throw new Error()
        const d = (await res.json()) as { source: string; live: boolean | null; serverOk?: boolean }
        if (!cancelled) setServerLive(d.source === "local" ? Boolean(d.live) : null)
      } catch {
        // mantener el último valor conocido (el banner de backend caído aparece por el watchdog)
      }
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // ---------- WATCHDOG: salud del backend + reconexión de datos ----------
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" })
        if (!res.ok) throw new Error()
        failCountRef.current = 0
        setBackendOnline(true)
      } catch {
        failCountRef.current += 1
        if (failCountRef.current >= 3) setBackendOnline(false)
      }
    }
    const id = setInterval(check, 30_000)
    const onOnline = () => {
      setBackendOnline(true)
      fetchContent()
    }
    window.addEventListener("online", onOnline)
    return () => {
      clearInterval(id)
      window.removeEventListener("online", onOnline)
    }
  }, [fetchContent])

  // ---------- Modo Kiosco: cursor, wake lock, teclas, contextmenu ----------
  useEffect(() => {
    // Seguimiento del estado de pantalla completa (oculta la marca de plataforma)
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", onFullscreenChange)

    let hideTimer: ReturnType<typeof setTimeout>
    const showCursor = () => {
      setCursorHidden(false)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => setCursorHidden(true), 4000)
    }
    showCursor()
    window.addEventListener("mousemove", showCursor)
    window.addEventListener("touchstart", showCursor)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "s" || e.key === "S") setShowPicker((v) => !v)
    }
    const noMenu = (e: Event) => e.preventDefault()
    window.addEventListener("keydown", onKey)
    window.addEventListener("contextmenu", noMenu)

    // Mantener pantalla encendida (Wake Lock API — Chrome/Android)
    let wakeLock: { release: () => Promise<void> } | null = null
    const requestWake = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }
        if (nav.wakeLock) wakeLock = await nav.wakeLock.request("screen")
      } catch {
        /* no soportado */
      }
    }
    requestWake()
    const onVis = () => {
      if (document.visibilityState === "visible") requestWake()
    }
    document.addEventListener("visibilitychange", onVis)

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange)
      clearTimeout(hideTimer)
      window.removeEventListener("mousemove", showCursor)
      window.removeEventListener("touchstart", showCursor)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("contextmenu", noMenu)
      document.removeEventListener("visibilitychange", onVis)
      wakeLock?.release().catch(() => {})
    }
  }, [])

  // ---------- Reporte de métricas del stream al servicio realtime ----------
  const onMetrics = useCallback((m: StreamMetrics) => {
    metricsRef.current = m
    const socket = socketRef.current
    if (socket?.connected) {
      socket.emit("stream:report", {
        state: m.state,
        resolution: m.resolution,
        bitrate: m.bitrate,
        latency: undefined,
        uptime: m.uptime,
        reconnects: m.reconnects,
      })
    }
  }, [])

  // ---------- Derivados ----------
  const s: PublicSettings | null = content?.settings ?? null
  const now = useMemo(() => new Date(), [content])
  const activePromos = useMemo(() => (content ? content.promotions.filter((p) => promoVisible(now, p)) : []), [content, now])
  const dishes = useMemo(() => (content ? pickDishes(now, content.dishes) : []), [content, now])
  const tickerTexts = useMemo(() => content?.ticker.map((t) => t.text) ?? [], [content])

  const handleSelectScreen = (code: string | null) => {
    if (code) localStorage.setItem(SCREEN_KEY, code)
    else localStorage.removeItem(SCREEN_KEY)
    localStorage.setItem(SCREEN_CHOSEN_KEY, "1")
    setScreenCode(code)
    setShowPicker(false)
    // Re-registrar identidad con el nuevo código
    window.location.reload()
  }

  // ---------- Tema / variables CSS ----------
  const cssVars = {
    ["--tv-primary" as string]: s?.primaryColor ?? "#f5a623",
    ["--tv-accent" as string]: s?.accentColor ?? "#e8452c",
    ["--tv-bg" as string]: s?.bgColor ?? "#0b0b0f",
    ["--tv-surface" as string]: s?.surfaceColor ?? "#15151b",
    ["--tv-glow" as string]: `color-mix(in srgb, ${s?.primaryColor ?? "#f5a623"} 32%, transparent)`,
    ["--fscale" as string]: String(s?.fontScale ?? 1),
    ["--anim-speed" as string]: String(s?.animationSpeed ?? 1),
  } as React.CSSProperties

  // ---------- Pantalla de carga / error ----------
  if (!content) {
    return (
      <div className={`fixed inset-0 flex flex-col items-center justify-center gap-6 bg-[#0b0b0f] ${cursorHidden ? "tv-cursor-hidden" : ""}`}>
        {loadError ? (
          <>
            <AlertTriangle size={56} className="text-amber-400" />
            <div className="text-center">
              <p className="text-2xl font-bold text-white mb-2">No se pudo conectar con el servidor</p>
              <p className="text-white/50">Reintentando automáticamente…</p>
            </div>
            <button
              onClick={fetchContent}
              className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 text-black font-bold hover:bg-amber-400 transition-colors"
            >
              <RefreshCw size={18} /> Reintentar ahora
            </button>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full border-4 border-white/10 border-t-amber-400 animate-spin" />
            <p className="tv-font-display text-3xl text-white tracking-widest">CARGANDO SEÑALIZACIÓN…</p>
          </>
        )}
      </div>
    )
  }

  const leftWidth = Math.round((1 - (s?.streamRatio ?? 0.5)) * 100)
  const rightWidth = 100 - leftWidth

  return (
    <div className={`tv-root ${cursorHidden ? "tv-cursor-hidden" : ""} ${showPicker ? "" : ""}`} style={cssVars}>
      {/* ====== CABECERA: Fecha/Hora · Horario del día · Logo ====== */}
      <header
        className="flex items-center justify-between gap-[2vw] px-[1.6vw] border-b border-white/8"
        style={{ paddingTop: "1.2vh", paddingBottom: "1.2vh", background: "color-mix(in srgb, var(--tv-bg) 60%, #000 40%)" }}
      >
        <Clock
          clockFormat={s!.clockFormat}
          showDate={s!.showDate}
          showSeconds={s!.showSeconds}
          showDay={s!.showDay}
          timezone={s!.timezone}
          language={s!.language}
        />
        {s!.showSchedule && (
          <div className="flex-1 flex justify-center min-w-0">
            <DailySchedule schedules={content.schedules} animationsEnabled={s!.animationsEnabled} />
          </div>
        )}
        <div style={{ justifySelf: s!.logoPosition === "left" ? "start" : "end" }}>
          <RestaurantLogo logoUrl={s!.logoUrl} restaurantName={s!.restaurantName} size={s!.logoSize} />
        </div>
      </header>

      {/* ====== ZONA PRINCIPAL: Promociones+Plato | TRANSMISIÓN ====== */}
      <main
        className="tv-main grid gap-[1vw] px-[1.6vw] min-h-0"
        style={{
          gridTemplateColumns: `${leftWidth}fr ${rightWidth}fr`,
          paddingTop: "1.2vh",
          paddingBottom: "1.2vh",
        }}
      >
        {/* Columna izquierda: promociones dominantes + banner compacto de sugerencias */}
        <div className="tv-left-col flex flex-col gap-[1vh] min-h-0">
          {s!.showPromotions && activePromos.length > 0 && (
            <PromotionsCarousel
              promotions={activePromos}
              animationsEnabled={s!.animationsEnabled}
              animationSpeed={s!.animationSpeed}
            />
          )}
          {s!.showDish && (
            <DishOfTheDay dishes={dishes} animationsEnabled={s!.animationsEnabled} animationSpeed={s!.animationSpeed} />
          )}
        </div>

        {/* TRANSMISIÓN — elemento dominante */}
        <div className="tv-stream-col min-h-0 h-full">
          <StreamPlayer settings={s!} audioConfig={audioConfig} onMetrics={onMetrics} serverLive={serverLive} />
        </div>
      </main>

      {/* ====== REDES SOCIALES ====== */}
      {s!.showSocials && <SocialLinks socials={content.socials} animationsEnabled={s!.animationsEnabled} />}

      {/* ====== TICKER ====== */}
      {s!.showTicker && s!.tickerEnabled && (
        <NewsTicker
          messages={tickerTexts}
          speed={s!.tickerSpeed}
          paused={s!.tickerPaused}
          restaurantName={s!.restaurantName}
        />
      )}

      {/* ====== OVERLAYS ====== */}
      {showPicker && (
        <ScreenPicker
          screens={content.screens}
          current={screenCode}
          onSelect={handleSelectScreen}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* Backend caído: banner sutil no intrusivo */}
      {!backendOnline && (
        <div className="fixed top-[1vh] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full px-4 py-1.5 bg-red-500/90 text-white text-sm font-semibold shadow-lg">
          <AlertTriangle size={16} />
          Reconectando con el servidor…
        </div>
      )}

      {/* Botón pantalla completa (sutil, esquina) */}
      <button
        onClick={() => {
          if (document.fullscreenElement) document.exitFullscreen()
          else document.documentElement.requestFullscreen()
        }}
        aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
        className="fixed bottom-[5.6vh] right-[1.4vw] z-40 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-all"
        style={{ width: "calc(3.4vh * var(--fscale,1))", height: "calc(3.4vh * var(--fscale,1))", minHeight: 34, minWidth: 34, opacity: cursorHidden ? 0 : 1 }}
      >
        {isFullscreen ? <Minimize size="55%" /> : <Maximize size="55%" />}
      </button>

      {/* Marca de la plataforma ViewLBA — solo visible FUERA de pantalla completa,
          para no competir con el contenido del restaurante en modo kiosco */}
      {!isFullscreen && (
        <img
          src={APP_LOGO_MARK}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="fixed bottom-[6.9vh] left-[1.2vw] z-30 pointer-events-none select-none opacity-25"
          style={{ height: "calc(2.8vh * var(--fscale, 1))", width: "auto" }}
        />
      )}

      {/* Identidad de pantalla (indicador discreto) */}
      {screenCode && (
        <div
          className="fixed top-[0.8vh] left-1/2 -translate-x-1/2 z-30 text-white/20 tv-font-display pointer-events-none"
          style={{ fontSize: "calc(1.2vh)" }}
        >
          {screenCode}
        </div>
      )}
    </div>
  )
}
