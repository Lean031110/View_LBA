"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Maximize, Minimize, RefreshCw } from "lucide-react"
import type { Socket } from "socket.io-client"
import type { ContentBundle, PublicSettings } from "@/lib/types"
import { connectSocket } from "@/lib/client-socket"
import { APP_LOGO_MARK } from "@/lib/brand"
import { getTimeParts, inPromoWindow, pickDishesForToday, type TimeParts } from "@/lib/timezone"
import Clock from "./Clock"
import DailySchedule from "./DailySchedule"
import RestaurantLogo from "./RestaurantLogo"
import PromotionsCarousel from "./PromotionsCarousel"
import DishOfTheDay from "./DishOfTheDay"
import StreamPlayer, { type StreamMetrics } from "./StreamPlayer"
import SocialLinks from "./SocialLinks"
import NewsTicker from "./NewsTicker"
import ScreenPicker from "./ScreenPicker"
import { WifiOff } from "lucide-react"

const SCREEN_KEY = "signage.screenCode"
const SCREEN_CHOSEN_KEY = "signage.screenChosen"
const SCREEN_TOKEN_KEY = "signage.screenToken" // token de pairing (FASE 5/32)

/**
 * PANTALLA TV — Aplicación de señalización digital para televisores.
 * Layout responsive basado en proporciones (vh/vw/grid), modo kiosco,
 * actualización realtime vía WebSocket y watchdog de recuperación.
 */
export default function TvDisplay() {
  const [content, setContent] = useState<ContentBundle | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [backendOnline, setBackendOnline] = useState(true)
  const [staleContent, setStaleContent] = useState(false) // FASE 34: mostrando último contenido conocido
  const [screenCode, setScreenCode] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [pairCode, setPairCode] = useState<string | null>(null) // FASE 32: código temporal de vinculación
  const [pairError, setPairError] = useState<string | null>(null)
  const [cursorHidden, setCursorHidden] = useState(false)
  const [audioConfig, setAudioConfig] = useState<{ volume: number; muted: boolean; deviceId: string | null } | null>(null)
  const [serverLive, setServerLive] = useState<boolean | null>(null) // estado del servidor RTMP local (OBS)
  const [isFullscreen, setIsFullscreen] = useState(false) // la marca ViewLBA solo se muestra fuera de pantalla completa
  const socketRef = useRef<Socket | null>(null)
  const failCountRef = useRef(0)
  const metricsRef = useRef<StreamMetrics | null>(null)

  // ---------- Carga de contenido ----------
  // FASE 34 (offline): el último bundle VÁLIDO se persiste en localStorage
  // (solo datos públicos de /api/content — jamás datos privados del admin);
  // si el servidor no responde (LAN caída tras recarga/reinicio de la TV),
  // se muestra ese último contenido conocido en lugar de una pantalla vacía.
  const CONTENT_KEY = "signage.lastContent"
  const CONTENT_TTL_MS = 24 * 60 * 60 * 1000 // 24h: contenido claramente obsoleto tras un día

  const fetchContent = useCallback(async () => {
    try {
      const res = await fetch("/api/content", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = (await res.json()) as ContentBundle
      setContent(data)
      setLoadError(false)
      setBackendOnline(true)
      setStaleContent(false)
      failCountRef.current = 0
      // persistir el último válido (best-effort; quota excepcional → ignorar)
      try {
        localStorage.setItem(CONTENT_KEY, JSON.stringify({ ts: Date.now(), data }))
      } catch {}
    } catch {
      // offline: ¿tenemos último contenido conocido aún fresco?
      try {
        const raw = localStorage.getItem(CONTENT_KEY)
        if (raw) {
          const { ts, data } = JSON.parse(raw) as { ts: number; data: ContentBundle }
          if (Date.now() - ts < CONTENT_TTL_MS && data) {
            setContent((prev) => prev ?? data) // no pisar contenido en memoria más nuevo
            setStaleContent(true)
            setBackendOnline(false)
            setLoadError(false)
            return
          }
        }
      } catch {}
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

  // ---------- FASE 34: Service Worker (shell offline de la TV) ----------
  // Solo en producción (en dev rompería HMR). El SW cachea el shell y el
  // último /api/content para sobrevivir a recargas con el servidor caído.
  // NUNCA cachea /api/admin/* ni /api/auth/* (datos privados).
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
    navigator.serviceWorker.register("/sw-tv.js").catch(() => {
      // registro fallido (contexto sin SW): la TV funciona igual (memoria)
    })
  }, [])

  // ---------- FASE 32: código temporal de vinculación ----------
  // TV no emparejada (picker visible sin identidad) → genera un código de
  // 6 dígitos que el ADMIN introduce en el panel (Pantallas → Nueva
  // pantalla). El servidor hará llegar el token por este código y aquí se
  // persiste (localStorage) → reinicios conservan la identidad verificada.
  const pairCodeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!showPicker || screenCode) return
    const gen = () => {
      const digits = new Uint32Array(6)
      crypto.getRandomValues(digits)
      const code = Array.from(digits, (d) => String(d % 10)).join("")
      pairCodeRef.current = code
      setPairCode(code)
      setPairError(null)
      // esperar en el room de pairing (re-emite si el código se renueva)
      const sock = socketRef.current
      if (sock?.connected) sock.emit("pair:wait", { pairCode: code })
    }
    gen()
  }, [showPicker, screenCode])

  // ---------- Realtime: cambios instantáneos desde administración ----------
  useEffect(() => {
    const socket = connectSocket()
    socketRef.current = socket

    socket.on("connect", () => {
      socket.emit("screen:register", {
        screenCode: localStorage.getItem(SCREEN_KEY) ?? "ANON",
        resolution: `${window.screen.width}×${window.screen.height}`,
        userAgent: navigator.userAgent.slice(0, 120),
        // FASE 5: token de pairing si la pantalla fue emparejada
        token: localStorage.getItem(SCREEN_TOKEN_KEY) ?? undefined,
      })
      // FASE 32: TV sin identidad esperando su código de vinculación
      if (!localStorage.getItem(SCREEN_KEY) && pairCodeRef.current) {
        socket.emit("pair:wait", { pairCode: pairCodeRef.current })
      }
    })

    // FASE 5: la pantalla no fue aceptada por el servicio (código desconocido,
    // inactiva o token inválido) → mostrar el selector para re-vincular
    socket.on("screen:rejected", (d: { reason?: string; message?: string }) => {
      console.warn("[TV] Registro rechazado:", d?.reason)
      // Token invalidado (p. ej. regenerado desde el panel) → limpiar la
      // identidad caducada y ofrecer re-vinculación por código (FASE 32)
      if (d?.reason === "bad-token" && localStorage.getItem(SCREEN_TOKEN_KEY)) {
        localStorage.removeItem(SCREEN_TOKEN_KEY)
        localStorage.removeItem(SCREEN_KEY)
        setScreenCode(null)
      }
      setShowPicker(true)
    })

    // FASE 32: el admin vinculó esta TV (introdujo el código en el panel) →
    // llega {screenCode, token, name} → persistir y re-registrar verificada
    socket.on("pair:complete", (d: { screenCode?: string; token?: string; name?: string }) => {
      if (!d?.screenCode || !d?.token) return
      localStorage.setItem(SCREEN_KEY, String(d.screenCode))
      localStorage.setItem(SCREEN_TOKEN_KEY, String(d.token))
      localStorage.setItem(SCREEN_CHOSEN_KEY, "1")
      setScreenCode(String(d.screenCode))
      setPairCode(null)
      pairCodeRef.current = null
      setShowPicker(false)
      // re-registro inmediato con el token recién recibido (verificado)
      socket.emit("screen:register", {
        screenCode: String(d.screenCode),
        resolution: `${window.screen.width}×${window.screen.height}`,
        userAgent: navigator.userAgent.slice(0, 120),
        token: String(d.token),
      })
    })

    // El código temporal caducó (10 min sin vincular) → renovar y seguir esperando
    socket.on("pair:expired", () => {
      if (!pairCodeRef.current) return
      const digits = new Uint32Array(6)
      crypto.getRandomValues(digits)
      const code = Array.from(digits, (d) => String(d % 10)).join("")
      pairCodeRef.current = code
      setPairCode(code)
      socket.emit("pair:wait", { pairCode: code })
    })

    socket.on("pair:error", (d: { error?: string }) => {
      setPairError(d?.error ?? "Error de vinculación")
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
        // FASE 32: mantener viva la espera de vinculación (re-unirse al room
        // pair:<código> tras cualquier reemplazo de sesión del socket)
        if (!localStorage.getItem(SCREEN_KEY) && pairCodeRef.current) {
          socket.emit("pair:wait", { pairCode: pairCodeRef.current })
        }
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

  // ---------- FASE 7: audio — la TV enumera SUS dispositivos y reporta ----------
  // (NUNCA pide micrófono: enumerateDevices funciona sin permiso; las
  // etiquetas pueden venir vacías y se numeran — no rompe la enumeración)
  useEffect(() => {
    const report = () => {
      const socket = socketRef.current
      if (!socket?.connected) return
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => {
          const outs = all
            .filter((d) => d.kind === "audiooutput")
            .slice(0, 16)
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Dispositivo ${i + 1}` }))
          const el = document.createElement("audio")
          const supportsSinkId = typeof (el as HTMLVideoElement & { setSinkId?: unknown }).setSinkId === "function"
          socket.emit("screen:audio", { devices: outs, supportsSinkId })
        })
        .catch(() => {})
    }
    // Reportar al conectar y cuando cambian los dispositivos (HDMI conectado, etc.)
    const t = setTimeout(report, 1500) // deja conectar el socket primero
    navigator.mediaDevices?.addEventListener?.("devicechange", report)
    return () => {
      clearTimeout(t)
      navigator.mediaDevices?.removeEventListener?.("devicechange", report)
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
  // FASE 8: TODO el contenido programado se evalúa en la zona horaria del
  // RESTAURANTE (Settings.timezone), nunca en la del navegador de la TV.
  const now = useMemo(() => new Date(), [content])
  const tzParts: TimeParts = useMemo(
    () => getTimeParts(now, s?.timezone ?? "America/Havana"),
    [now, s?.timezone]
  )
  const activePromos = useMemo(
    () => (content ? content.promotions.filter((p) => inPromoWindow(tzParts, now, p)) : []),
    [content, now, tzParts]
  )
  const dishes = useMemo(
    () => (content ? pickDishesForToday(tzParts, content.dishes) : []),
    [content, tzParts]
  )
  const tickerTexts = useMemo(() => content?.ticker.map((t) => t.text) ?? [], [content])
  // FASE 7: salida de audio persistida de ESTA pantalla (elegida por el admin
  // de la lista que este mismo navegador reportó)
  const screenAudioDeviceId = useMemo(
    () => content?.screens.find((sc) => sc.code === screenCode)?.audioDeviceId ?? null,
    [content, screenCode]
  )

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
            <DailySchedule schedules={content.schedules} animationsEnabled={s!.animationsEnabled} timezone={s!.timezone} />
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
          <StreamPlayer
            settings={s!}
            audioConfig={audioConfig}
            onMetrics={onMetrics}
            serverLive={serverLive}
            initialSinkId={screenAudioDeviceId}
          />
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
          pairCode={!screenCode ? pairCode : null}
          pairError={pairError}
        />
      )}

      {/* Backend caído: banner sutil no intrusivo */}
      {!backendOnline && (
        <div className="fixed top-[1vh] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full px-4 py-1.5 bg-red-500/90 text-white text-sm font-semibold shadow-lg">
          <AlertTriangle size={16} />
          Reconectando con el servidor…
        </div>
      )}

      {/* FASE 34: sin servidor + último contenido conocido (la TV sigue viva) */}
      {staleContent && (
        <div className="fixed top-[4.6vh] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full px-4 py-1 bg-amber-500/85 text-black text-xs font-bold shadow-lg">
          <WifiOff size={13} />
          Sin conexión — mostrando el último contenido conocido
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
