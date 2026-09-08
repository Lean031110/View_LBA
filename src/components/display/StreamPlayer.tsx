"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Hls from "hls.js"
import type Mpegts from "mpegts.js"
import { Volume2, VolumeX, Maximize, Minimize, RadioTower, Loader2, WifiOff } from "lucide-react"
import type { PublicSettings, StreamState } from "@/lib/types"

export interface StreamMetrics {
  state: StreamState
  resolution?: string
  bitrate?: number
  uptime?: number
  reconnects?: number
}

interface Props {
  settings: PublicSettings
  audioConfig: { volume: number; muted: boolean; deviceId: string | null } | null
  onMetrics?: (m: StreamMetrics) => void
  /** Estado del servidor RTMP local (modo "local"): null = desconocido/externo */
  serverLive?: boolean | null
  /** FASE 7: deviceId persistido de ESTA pantalla (de Screen.audioDeviceId) */
  initialSinkId?: string | null
}

type UiState = "connecting" | "live" | "reconnecting" | "fallback" | "waiting" | "disabled"

/** Convierte estado UI → estado reportado al panel admin */
function toReported(s: UiState): StreamState {
  switch (s) {
    case "live":
      return "live"
    case "connecting":
    case "reconnecting":
      return "connecting"
    case "disabled":
    case "waiting":
      return "disabled"
    default:
      return "fallback"
  }
}

const MAX_FAST_RETRIES = 3
const FAST_RETRY_DELAY_MS = 5000 // 5s, 10s, 15s
const FALLBACK_RETRY_DELAY_MS = 30_000 // en fallback, seguir probando cada 30s

/** URL del proxy FLV del servidor RTMP integrado (la clave NUNCA llega al navegador) */
const LOCAL_FLV_URL = "/api/stream/live.flv"

/**
 * TRANSMISIÓN (StreamPlayer) — el elemento dominante de la pantalla.
 *
 * Dos modos:
 *  · local   → servidor RTMP integrado en LAN: HTTP-FLV vía mpegts.js con
 *              persecución de latencia (live chasing). Se activa solo cuando
 *              el servidor detecta publicador (OBS) y cae a fallback al parar.
 *  · external→ HLS (hls.js) o video directo por URL.
 *
 * Reconexión automática, watchdog anti-congelamiento y contenido de respaldo.
 */
export default function StreamPlayer({ settings, audioConfig, onMetrics, serverLive = null, initialSinkId = null }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const flvRef = useRef<Mpegts.Player | null>(null)
  const mpegtsModuleRef = useRef<typeof Mpegts | null>(null)
  const flvStatsRef = useRef<{ resolution?: string; bitrateBps?: number }>({})
  const genRef = useRef(0) // guard anti race-condition en carga async del player

  const [uiState, setUiState] = useState<UiState>("connecting")
  const [attempt, setAttempt] = useState(0)
  const [localMuted, setLocalMuted] = useState(settings.audioMuted)
  const [localVolume, setLocalVolume] = useState(settings.audioVolume)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Refs para usar dentro de listeners/intervals sin recrearlos
  const stateRef = useRef<UiState>("connecting")
  const attemptsRef = useRef(0)
  const liveSinceRef = useRef<number | null>(null)
  const reconnectsRef = useRef(0)
  const stallTicksRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rebuildRef = useRef<() => void>(() => {})

  const isLocal = (settings.streamSource ?? "external") === "local"

  const setState = useCallback((s: UiState) => {
    stateRef.current = s
    setUiState(s)
    if (s === "live") {
      if (liveSinceRef.current === null) liveSinceRef.current = Date.now()
      attemptsRef.current = 0
      setAttempt(0)
      stallTicksRef.current = 0
    }
  }, [])

  const clearRetryTimer = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }

  const teardown = useCallback(() => {
    genRef.current += 1 // invalida cargas async en curso
    clearRetryTimer()
    liveSinceRef.current = null // el uptime se reinicia por sesión de live
    if (flvRef.current) {
      try {
        flvRef.current.pause()
        flvRef.current.unload()
        flvRef.current.detachMediaElement()
        flvRef.current.destroy()
      } catch {}
      flvRef.current = null
    }
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    flvStatsRef.current = {}
    const video = videoRef.current
    if (video) {
      video.removeAttribute("src")
      video.load()
    }
  }, [])

  /** Programa reintento con backoff → tras N fallos pasa a fallback (sigue reintentando) */
  const scheduleRetry = useCallback(() => {
    if (stateRef.current === "disabled" || stateRef.current === "waiting") return
    clearRetryTimer()
    attemptsRef.current += 1
    reconnectsRef.current += 1
    const n = attemptsRef.current
    setAttempt(n)

    if (n <= MAX_FAST_RETRIES) {
      setState("reconnecting")
      retryTimerRef.current = setTimeout(() => rebuildRef.current(), FAST_RETRY_DELAY_MS * n)
    } else {
      setState("fallback")
      retryTimerRef.current = setTimeout(() => rebuildRef.current(), FALLBACK_RETRY_DELAY_MS)
    }
  }, [setState])

  /** Autoplay respetando políticas del navegador (silenciar y reintentar) */
  const tryPlay = () => {
    const video = videoRef.current
    const p = video?.play()
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        if (video && !video.muted) {
          video.muted = true
          setLocalMuted(true)
          video.play().catch(() => {})
        }
      })
    }
  }

  /** Reconstruye el player desde cero (watchdog / reintento / cambio de fuente) */
  const rebuild = useCallback(() => {
    const url = settings.streamUrl
    const enabled = settings.streamEnabled
    teardown()
    if (!enabled) {
      setState(enabled ? "waiting" : "disabled")
      return
    }
    if (isLocal) {
      // ---- MODO LOCAL: servidor RTMP integrado (HTTP-FLV por proxy) ----
      if (serverLive === false) {
        // OBS no está publicando → fallback (se reactiva solo al volver "live")
        setState("fallback")
        return
      }
      setState("connecting")
      const video = videoRef.current
      if (!video) return
      const gen = genRef.current
      void (async () => {
        try {
          const mod = mpegtsModuleRef.current ?? (await import("mpegts.js")).default
          mpegtsModuleRef.current = mod
          if (genRef.current !== gen) return // fue desmontado mientras cargaba
          if (!mod.getFeatureList().mseLivePlayback) {
            // Navegador sin MSE para FLV en vivo → fallback
            setState("fallback")
            return
          }
          const player = mod.createPlayer(
            { type: "flv", isLive: true, url: LOCAL_FLV_URL },
            {
              // Sin worker: máxima compatibilidad con navegadores de TV/kiosco
              // (los workers blob fallan en varios WebKit/Blink embebidos) y
              // permite depurar el flujo en el hilo principal.
              enableWorker: false,
              enableStashBuffer: false, // baja latencia: no acumular entrada
              liveBufferLatencyChasing: true, // perseguir el borde en vivo
              liveBufferLatencyMaxLatency: 1.8,
              liveBufferLatencyMinRemovable: 0.4, // opción en runtime (no declarada en el .d.ts)
              lazyLoad: false,
              autoCleanupSourceBuffer: true, // 24/7 sin fugas de memoria
              stashInitialSize: 128,
            } as unknown as NonNullable<Parameters<typeof mod.createPlayer>[1]>
          )
          if (genRef.current !== gen) {
            try {
              player.destroy()
            } catch {}
            return
          }
          flvRef.current = player
          player.attachMediaElement(video)
          player.on(mod.Events.MEDIA_INFO, (info: { width?: number; height?: number }) => {
            if (info?.width && info?.height) flvStatsRef.current.resolution = `${info.width}×${info.height}`
          })
          player.on(mod.Events.STATISTICS_INFO, (stats: { speed?: number }) => {
            if (stats && typeof stats.speed === "number" && stats.speed > 0) {
              flvStatsRef.current.bitrateBps = Math.round(stats.speed * 1024 * 8)
            }
          })
          player.on(mod.Events.ERROR, (errType: string, errDetail: string) => {
            if (genRef.current !== gen || !flvRef.current) return
            console.error("[StreamPlayer] mpegts ERROR:", errType, errDetail)
            if (errType === mod.ErrorTypes.NETWORK_ERROR) {
              scheduleRetry()
            } else if (errType === mod.ErrorTypes.MEDIA_ERROR) {
              // Recuperación suave: recargar el flujo
              try {
                player.unload()
                player.load()
                player.play()
              } catch {
                scheduleRetry()
              }
            } else {
              scheduleRetry()
            }
          })
          player.load()
          player.play()
          tryPlay()
        } catch (e) {
          console.error("[StreamPlayer] error iniciando mpegts:", e)
          if (genRef.current === gen) scheduleRetry()
        }
      })()
      return
    }

    // ---- MODO EXTERNO: HLS / MP4 por URL ----
    if (!url) {
      setState("waiting")
      return
    }
    setState("connecting")
    const video = videoRef.current
    if (!video) return

    const protocol = settings.streamProtocol || "hls"
    if (protocol === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 12,
        liveSyncDurationCount: 3,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        fragLoadingTimeOut: 20000,
      })
      hlsRef.current = hls
      hls.attachMedia(video)
      hls.loadSource(url)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.currentLevel = -1 // calidad automática (adaptativa)
        tryPlay()
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          scheduleRetry()
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hls.recoverMediaError()
          } catch {
            scheduleRetry()
          }
        } else {
          scheduleRetry()
        }
      })
    } else if (protocol === "hls" && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url
      tryPlay()
    } else {
      video.src = url
      video.loop = false
      tryPlay()
    }
  }, [settings.streamUrl, settings.streamEnabled, settings.streamProtocol, settings.streamSource, serverLive, isLocal, setState, teardown, scheduleRetry])

  useEffect(() => {
    rebuildRef.current = rebuild
  }, [rebuild])

  // ---------- Setup inicial (cambia configuración del stream / estado del servidor) ----------
  useEffect(() => {
    if (!settings.streamEnabled) {
      teardown()
      return
    }
    if (isLocal && serverLive === false) {
      // El servidor RTMP no tiene publicador (OBS detenido) → fallback
      teardown()
      return
    }
    // Inicialización imperativa del player (mpegts/hls/<video>): la transición
    // a "connecting" forma parte del ciclo de vida del player, no de React.
    rebuild()
    return () => teardown()
  }, [settings.streamUrl, settings.streamEnabled, settings.streamProtocol, settings.streamSource, serverLive])

  // ---------- Eventos del <video>: como props de React ----------
  const handleVideoPlaying = () => setState("live")
  const handleVideoWaiting = () => {
    if (stateRef.current === "live") setState("connecting")
  }
  const handleVideoError = () => {
    if (stateRef.current !== "reconnecting" && stateRef.current !== "fallback") scheduleRetry()
  }

  // ---------- WATCHDOG: cada 5s comprueba salud del player ----------
  // Auto-sanación: si el video avanza pero el estado no es "live" (eventos
  // perdidos, pestaña en segundo plano), se corrige automáticamente.
  useEffect(() => {
    let lastTime = -1
    const id = setInterval(() => {
      const video = videoRef.current
      if (video && stateRef.current === "connecting" && !video.paused && video.readyState >= 3 && video.currentTime > lastTime + 0.05) {
        setState("live")
      }
      lastTime = video ? video.currentTime : -1

      const eff: UiState = !settings.streamEnabled
        ? "disabled"
        : isLocal
          ? serverLive === false
            ? "fallback"
            : stateRef.current
          : !settings.streamUrl
            ? "waiting"
            : stateRef.current
      const s = eff
      if (s === "live" && video) {
        const stalled = video.readyState < 2 || (video.paused && !video.ended)
        if (stalled) {
          stallTicksRef.current += 1
          if (stallTicksRef.current >= 2) {
            // congelado ~10s → reconstruir
            stallTicksRef.current = 0
            scheduleRetry()
          }
        } else {
          stallTicksRef.current = 0
        }
      }
      // Reportar métricas al orquestador (TV → admin)
      const res =
        (video && video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : undefined) ?? flvStatsRef.current.resolution
      const level = hlsRef.current && hlsRef.current.currentLevel >= 0 ? hlsRef.current.levels[hlsRef.current.currentLevel] : undefined
      onMetrics?.({
        state: toReported(s),
        resolution: res,
        bitrate: level?.bitrate ?? flvStatsRef.current.bitrateBps,
        uptime: liveSinceRef.current ? Math.floor((Date.now() - liveSinceRef.current) / 1000) : 0,
        reconnects: reconnectsRef.current,
      })
    }, 5000)
    return () => clearInterval(id)
  }, [onMetrics, scheduleRetry, setState, settings.streamEnabled, settings.streamUrl, settings.streamSource, serverLive, isLocal])

  // ---------- Audio: volumen local + configuración remota ----------
  const [appliedCfg, setAppliedCfg] = useState(audioConfig)
  if (audioConfig !== appliedCfg) {
    setAppliedCfg(audioConfig)
    if (audioConfig) {
      setLocalVolume(audioConfig.volume)
      setLocalMuted(audioConfig.muted)
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = Math.min(Math.max(localVolume, 0), 100) / 100
    video.muted = localMuted
  }, [localVolume, localMuted, uiState])

  // ---------- FASE 7: salida de audio (setSinkId) ----------
  // El deviceId es SIEMPRE de ESTE navegador (lo reporta esta propia TV y el
  // admin lo elige de esa lista). Si no existe o el navegador no soporta
  // setSinkId (Firefox/Safari/TVs antiguas) → salida predeterminada del
  // sistema, SIN romper la reproducción.
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null
    const deviceId = audioConfig?.deviceId ?? initialSinkId
    if (!deviceId || !video) return
    if (typeof video.setSinkId !== "function") {
      // Salida específica no compatible: se usará la predeterminada (misión F7)
      console.info("[StreamPlayer] setSinkId no soportado — usando salida predeterminada del sistema")
      return
    }
    video
      .setSinkId(deviceId)
      .catch((e: unknown) => {
        // deviceId de otra máquina / desconectado → NO romper el video:
        // cae a la salida predeterminada y se informa por consola
        console.warn("[StreamPlayer] No se pudo aplicar la salida de audio (usando la predeterminada):", (e as Error)?.message ?? e)
      })
  }, [audioConfig, initialSinkId, uiState])

  // ---------- Fullscreen ----------
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await containerRef.current?.requestFullscreen()
    } catch {
      /* TV/kiosk puede restringir fullscreen */
    }
  }

  // ---------- Render ----------
  // Estado efectivo: disabled/waiting/fallback-sin-OBS se derivan de la configuración
  const effState: UiState = !settings.streamEnabled
    ? "disabled"
    : isLocal
      ? serverLive === false
        ? "fallback"
        : uiState
      : !settings.streamUrl
        ? "waiting"
        : uiState
  const showVideo = effState === "live" || effState === "connecting" || effState === "reconnecting"
  const videoVisible = effState === "live"

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full rounded-[1.2vh] overflow-hidden border border-white/10 group"
      style={{
        background: "#000",
        boxShadow: "0 0 2.5vh 0 rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.04)",
      }}
      aria-label="Transmisión en vivo"
    >
      {/* Video */}
      {showVideo && (
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
          style={{ opacity: videoVisible ? 1 : 0.25 }}
          playsInline
          autoPlay={settings.autoplay}
          muted={localMuted}
          preload="auto"
          onPlaying={handleVideoPlaying}
          onWaiting={handleVideoWaiting}
          onError={handleVideoError}
        />
      )}

      {/* Fallback: mensaje */}
      {effState === "fallback" && settings.fallbackType === "message" && (
        <FallbackScreen message={settings.fallbackMessage} sub="Reintentando automáticamente…" icon="wifi" />
      )}
      {/* Fallback: imagen */}
      {effState === "fallback" && settings.fallbackType === "image" && (
        <div className="absolute inset-0">
          {settings.fallbackImageUrl && (
            <img src={settings.fallbackImageUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60" draggable={false} />
          )}
          <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.2))" }} />
          <div className="absolute bottom-[3vh] left-0 right-0 text-center">
            <span className="tv-font-display text-white" style={{ fontSize: "calc(3vh * var(--fscale,1))" }}>
              {settings.fallbackMessage}
            </span>
          </div>
        </div>
      )}
      {/* Fallback: video */}
      {effState === "fallback" && settings.fallbackType === "video" && settings.fallbackVideoUrl && (
        <div className="absolute inset-0">
          <video src={settings.fallbackVideoUrl} className="absolute inset-0 w-full h-full object-cover" autoPlay loop muted playsInline />
          <div className="absolute bottom-[3vh] left-0 right-0 text-center">
            <span className="tv-font-display text-white drop-shadow-lg" style={{ fontSize: "calc(2.6vh * var(--fscale,1))" }}>
              {settings.fallbackMessage}
            </span>
          </div>
        </div>
      )}

      {/* Esperando transmisión (sin URL configurada en modo externo) */}
      {effState === "waiting" && (
        <FallbackScreen message="ESPERANDO TRANSMISIÓN" sub="En cuanto inicies la transmisión desde OBS Studio, aparecerá aquí automáticamente" icon="radio" />
      )}
      {/* Transmisión deshabilitada */}
      {effState === "disabled" && (
        <FallbackScreen message="TRANSMISIÓN DESACTIVADA" sub="Actívala desde el panel de administración" icon="radio" />
      )}

      {/* Badge EN VIVO */}
      {(effState === "live" || effState === "connecting" || effState === "reconnecting") && (
        <div className="absolute top-[1.2vh] left-[1.2vh] flex items-center gap-[0.5vw] z-20">
          <div
            className="flex items-center gap-[0.45vw] rounded-[0.6vh] px-[0.9vw] py-[0.35vh] backdrop-blur-md"
            style={{
              background: effState === "live" ? "rgba(180,40,30,0.85)" : "rgba(0,0,0,0.55)",
              boxShadow: effState === "live" ? "0 0 1.5vh rgba(230,60,45,0.6)" : "none",
            }}
          >
            <span
              className={`rounded-full ${effState === "live" ? "tv-live-dot" : ""}`}
              style={{ width: "0.9vh", height: "0.9vh", background: effState === "live" ? "#ff5148" : "#f5a623", minHeight: "6px", minWidth: "6px" }}
            />
            <span className="tv-font-display text-white" style={{ fontSize: "calc(1.8vh * var(--fscale,1))", letterSpacing: "0.14em" }}>
              {effState === "live" ? "EN VIVO" : effState === "connecting" ? "CONECTANDO" : `RECONECTANDO · ${attempt}`}
            </span>
          </div>
        </div>
      )}

      {/* Indicador de conexión (esquina) */}
      {effState === "live" && (
        <div className="absolute top-[1.2vh] right-[1.2vh] z-20 flex items-center gap-[0.4vw] rounded-[0.6vh] px-[0.7vw] py-[0.25vh]" style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }}>
          <span className="rounded-full" style={{ width: "0.7vh", height: "0.7vh", background: "#3ddc84", minHeight: "5px", minWidth: "5px" }} />
          <span className="font-semibold text-white/80 tracking-wide" style={{ fontSize: "calc(1.3vh * var(--fscale,1))" }}>
            ESTABLE
          </span>
        </div>
      )}

      {/* Spinner central al conectar/reconectar */}
      {(effState === "connecting" || effState === "reconnecting") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[1.2vh] z-10 pointer-events-none">
          <Loader2 size="calc(4.5vh * var(--fscale,1))" className="tv-spinner text-white/85" />
          <span className="tv-font-display text-white/80 tracking-[0.2em]" style={{ fontSize: "calc(2vh * var(--fscale,1))" }}>
            {effState === "connecting" ? "CARGANDO TRANSMISIÓN" : "RECONECTANDO"}
          </span>
        </div>
      )}

      {/* Controles (aparecen al pasar el cursor / tocar) */}
      <div
        className="absolute bottom-0 left-0 right-0 z-30 flex items-center justify-end gap-[0.8vw] px-[1.2vw] py-[1vh] opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.65), transparent)" }}
      >
        <button
          onClick={() => {
            setLocalMuted((m) => !m)
          }}
          aria-label={localMuted ? "Activar sonido" : "Silenciar"}
          className="flex items-center justify-center rounded-full text-white hover:bg-white/15 transition-colors"
          style={{ width: "calc(3.6vh * var(--fscale,1))", height: "calc(3.6vh * var(--fscale,1))", minHeight: 34, minWidth: 34, background: "rgba(0,0,0,0.4)" }}
        >
          {localMuted ? <VolumeX size="55%" /> : <Volume2 size="55%" />}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={localVolume}
          onChange={(e) => {
            setLocalVolume(Number(e.target.value))
          }}
          onPointerDown={() => {}}
          aria-label="Volumen"
          className="w-[7vw] accent-white cursor-pointer"
          style={{ height: "calc(0.4vh)" }}
        />
        <button
          onClick={toggleFullscreen}
          aria-label="Pantalla completa"
          className="flex items-center justify-center rounded-full text-white hover:bg-white/15 transition-colors"
          style={{ width: "calc(3.6vh * var(--fscale,1))", height: "calc(3.6vh * var(--fscale,1))", minHeight: 34, minWidth: 34, background: "rgba(0,0,0,0.4)" }}
        >
          {isFullscreen ? <Minimize size="55%" /> : <Maximize size="55%" />}
        </button>
      </div>
    </div>
  )
}

/** Pantalla de estado elegante (fallback / espera) */
function FallbackScreen({ message, sub, icon }: { message: string; sub: string; icon: "wifi" | "radio" }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[1.4vh] text-center px-[2vw]"
      style={{
        background: "radial-gradient(ellipse at center, rgba(24,24,32,0.92) 0%, rgba(8,8,12,0.97) 100%)",
      }}
    >
      <div
        className="flex items-center justify-center rounded-full"
        style={{
          width: "calc(9vh * var(--fscale,1))",
          height: "calc(9vh * var(--fscale,1))",
          background: "color-mix(in srgb, var(--tv-primary) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--tv-primary) 35%, transparent)",
        }}
      >
        {icon === "wifi" ? (
          <WifiOff size="45%" style={{ color: "var(--tv-primary)" }} />
        ) : (
          <RadioTower size="45%" style={{ color: "var(--tv-primary)" }} className="tv-live-dot" />
        )}
      </div>
      <h3 className="tv-font-display text-white leading-tight" style={{ fontSize: "calc(4.2vh * var(--fscale,1))", letterSpacing: "0.08em" }}>
        {message}
      </h3>
      <p className="font-medium text-white/50 max-w-[36vw] leading-snug" style={{ fontSize: "calc(1.6vh * var(--fscale,1))" }}>
        {sub}
      </p>
    </div>
  )
}
