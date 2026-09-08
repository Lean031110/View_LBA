"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Radio, Save, Loader2, TestTube2, Info, Tv, MonitorPlay, Copy, Check, Eye, EyeOff,
  RefreshCw, Server, KeyRound, Network, ShieldCheck, ArrowRight, Signal, Wifi,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { useSettings } from "../useSettings"
import ImageUploadField from "../ImageUploadField"
import { getJSON, postJSON } from "../api"
import type { ScreenStatus } from "@/lib/types"
import type { StreamServerStatus } from "../AdminApp"

/** Stream de demostración EXTERNO (requiere Internet — no forma parte del
 *  modo 100% LAN; se configura manualmente como fuente externa opcional). */
const DEMO_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"

interface RtmpInfo {
  source: "local" | "external"
  streamEnabled: boolean
  host: string
  hostAuto: boolean
  rtmpPort: number
  rtmpApp: string
  rtmpUrl: string
  hasKey: boolean
  keyMasked: string | null
  key?: string
  server: {
    ok: boolean
    live: boolean
    since: number | null
    viewers: number
    publisherIp: string | null
    hasKey: boolean
    uptimeSec: number
  } | null
}

interface Props {
  user: { name: string; role: string }
  screensStatus: ScreenStatus[]
  realtimeConnected: boolean
  sendCommand: (t: string, p?: Record<string, unknown>, s?: string) => void
  section: string
  setSection: (s: string) => void
  streamServer: StreamServerStatus | null
}

function fmtUptime(sec: number | null | undefined): string {
  if (!sec || sec < 0) return "—"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Copiar al portapapeles con feedback visual */
function useCopy() {
  const { toast } = useToast()
  const [copied, setCopied] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(label)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(null), 1600)
      } catch {
        toast({ title: "No se pudo copiar", description: "Selecciona el texto y cópialo manualmente.", variant: "destructive" })
      }
    },
    [toast]
  )
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return { copy, copied }
}

export default function StreamSection({ user, screensStatus, streamServer }: Props) {
  const { settings, setSettings, saving, save } = useSettings()
  const { toast } = useToast()
  const { copy, copied } = useCopy()

  const [rtmpInfo, setRtmpInfo] = useState<RtmpInfo | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; status?: number; details?: string; error?: string } | null>(null)

  const isAdmin = user.role === "ADMIN"
  const isLocal = (settings?.streamSource ?? (rtmpInfo?.source ?? "local")) === "local"

  const refreshInfo = useCallback(async (reveal = false) => {
    try {
      const d = await getJSON<RtmpInfo>(`/api/admin/stream/rtmp${reveal && isAdmin ? "?reveal=1" : ""}`)
      setRtmpInfo(d)
      if (reveal && d.key) setRevealedKey(d.key)
      return d
    } catch {
      return null
    }
  }, [isAdmin])

  useEffect(() => {
    refreshInfo()
    const id = setInterval(() => refreshInfo(showKey), 10_000)
    return () => clearInterval(id)
  }, [showKey])

  if (!settings) return <Loading />
  const s = settings as Record<string, unknown>
  const set = (k: string, v: unknown) => setSettings({ ...settings, [k]: v } as Record<string, unknown>)

  const onSave = () => save(buildPatch(settings))

  // Estado en vivo del servidor: prioridad al evento realtime (instantáneo)
  const liveNow = streamServer?.source === "local" ? streamServer.live : rtmpInfo?.server?.live ?? false
  const since = streamServer?.since ?? rtmpInfo?.server?.since ?? null
  const viewers = streamServer?.viewers ?? rtmpInfo?.server?.viewers ?? 0
  const publisherIp = streamServer?.publisherIp ?? rtmpInfo?.server?.publisherIp ?? null
  const serverOk = rtmpInfo?.server?.ok ?? false
  const liveUptime = since ? Math.floor((Date.now() - since) / 1000) : 0

  const revealKey = async () => {
    if (showKey) {
      setShowKey(false)
      return
    }
    const d = await refreshInfo(true)
    if (d?.key) setShowKey(true)
    else toast({ title: "Sin permiso", description: "Solo un administrador puede ver la clave completa.", variant: "destructive" })
  }

  const regenerateKey = async () => {
    setRegenerating(true)
    try {
      const d = await postJSON<{ key: string }>("/api/admin/stream/rtmp", {})
      setRevealedKey(d.key)
      setShowKey(true)
      await refreshInfo(true)
      toast({
        title: "Clave regenerada",
        description: "Las nuevas conexiones de OBS deben usar la nueva clave. Vuelve a copiarla. La sesión que ya esté transmitiendo continúa hasta que OBS se detenga.",
      })
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally {
      setRegenerating(false)
    }
  }

  const testStream = async () => {
    const url = String(s.streamUrl ?? "")
    if (!url) {
      toast({ title: "Sin URL", description: "Introduce primero la URL del stream.", variant: "destructive" })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await postJSON<{ ok: boolean; latencyMs?: number; status?: number; details?: string; error?: string }>("/api/admin/stream-test", { url })
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const useDemo = () => {
    set("streamUrl", DEMO_HLS)
    set("streamProtocol", "hls")
    toast({ title: "Stream de demo listo", description: "Pulsa Guardar para publicarlo en las pantallas." })
  }

  const keyDisplay = showKey && revealedKey ? revealedKey : rtmpInfo?.keyMasked ?? "••••••••••••"

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Radio size={22} className="text-red-400" /> Transmisión
          </h1>
          <p className="text-white/45 text-sm mt-0.5">OBS Studio → Servidor RTMP integrado (LAN) → Pantallas TV</p>
        </div>
        <Button onClick={onSave} disabled={saving} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Guardar y publicar
        </Button>
      </div>

      {/* ====== FUENTE DE TRANSMISIÓN ====== */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-white">Fuente de la transmisión</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => set("streamSource", "local")}
              className={`rounded-xl border p-4 text-left transition-all ${isLocal ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 hover:border-white/30"}`}
            >
              <div className="flex items-center gap-2 font-semibold text-white text-sm">
                <Server size={15} className={isLocal ? "text-amber-400" : "text-white/50"} />
                Servidor integrado <span className="text-[10px] bg-emerald-500/15 text-emerald-300 rounded px-1.5 py-0.5">RECOMENDADO</span>
              </div>
              <div className="text-xs text-white/40 mt-1">Transmite por tu red local (LAN), sin Internet. Conecta OBS con la URL y clave de abajo.</div>
            </button>
            <button
              onClick={() => set("streamSource", "external")}
              className={`rounded-xl border p-4 text-left transition-all ${!isLocal ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 hover:border-white/30"}`}
            >
              <div className="flex items-center gap-2 font-semibold text-white text-sm">
                <Network size={15} className={!isLocal ? "text-amber-400" : "text-white/50"} />
                Servidor externo
              </div>
              <div className="text-xs text-white/40 mt-1">Reproduce un stream HLS/MP4 publicado en otro servidor (Internet o LAN).</div>
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-white/85">Transmisión habilitada</Label>
              <p className="text-xs text-white/40 mt-0.5">Si se desactiva, las pantallas muestran el contenido de respaldo.</p>
            </div>
            <Switch checked={Boolean(s.streamEnabled)} onCheckedChange={(v) => set("streamEnabled", v)} />
          </div>
        </CardContent>
      </Card>

      {/* ====== SERVIDOR RTMP INTEGRADO (modo local) ====== */}
      {isLocal && (
        <Card className="bg-white/[0.03] border-amber-400/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white flex items-center gap-2">
              <Server size={16} className="text-amber-400" /> Servidor de transmisión integrado
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full">
                {liveNow ? (
                  <span className="flex items-center gap-1.5 bg-red-500/15 text-red-400 border border-red-500/30 px-2.5 py-1 rounded-full">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> EN VIVO
                  </span>
                ) : serverOk ? (
                  <span className="flex items-center gap-1.5 bg-amber-500/10 text-amber-300 border border-amber-500/25 px-2.5 py-1 rounded-full">
                    <Signal size={11} /> ESPERANDO OBS
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 bg-zinc-500/10 text-zinc-400 border border-zinc-500/25 px-2.5 py-1 rounded-full">
                    <Wifi size={11} className="animate-pulse" /> SERVIDOR CAÍDO
                  </span>
                )}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {!serverOk && (
              <div className="flex gap-2 items-center rounded-lg bg-zinc-500/8 border border-zinc-500/20 px-3 py-2.5">
                <Info size={15} className="text-zinc-400 shrink-0" />
                <p className="text-xs text-zinc-300/70 leading-relaxed">
                  El servidor de streaming no responde. El supervisor lo reinicia automáticamente en segundos — si el problema persiste, revisa el registro <span className="font-mono">stream-service.log</span>.
                </p>
              </div>
            )}

            {/* Estadísticas del servidor */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Espectadores" value={String(viewers)} icon={<Tv size={13} />} live={liveNow} />
              <Stat label="Tiempo en vivo" value={liveNow ? fmtUptime(liveUptime) : "—"} live={liveNow} />
              <Stat label="IP de OBS" value={publisherIp ? publisherIp.split(":")[0] : "—"} live={liveNow} />
              <Stat label="Clave" value={rtmpInfo?.hasKey ? "configurada" : "sin generar"} live={rtmpInfo?.hasKey} />
            </div>

            {/* URL RTMP para OBS */}
            <div className="space-y-2">
              <Label className="text-white/85 flex items-center gap-1.5">
                <ArrowRight size={13} className="text-amber-400" /> Servidor RTMP (pégalo en OBS)
              </Label>
              <div className="flex gap-2">
                <div className="flex-1 flex items-center rounded-lg bg-black/40 border border-white/10 px-3 font-mono text-sm text-amber-200 overflow-x-auto whitespace-nowrap">
                  {rtmpInfo?.rtmpUrl ?? "rtmp://…"}
                </div>
                <Button
                  onClick={() => copy(rtmpInfo?.rtmpUrl ?? "", "URL RTMP copiada")}
                  variant="outline"
                  className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2 shrink-0"
                >
                  {copied === "URL RTMP copiada" ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />} Copiar
                </Button>
              </div>
              <p className="text-[11px] text-white/30">
                {rtmpInfo?.hostAuto ? `IP detectada automáticamente: ${rtmpInfo?.host}` : `IP manual configurada: ${rtmpInfo?.host}`} · puerto {rtmpInfo?.rtmpPort}
              </p>
            </div>

            {/* Clave de transmisión */}
            <div className="space-y-2">
              <Label className="text-white/85 flex items-center gap-1.5">
                <KeyRound size={13} className="text-amber-400" /> Clave de transmisión
              </Label>
              <div className="flex gap-2 flex-wrap">
                <div className="flex-1 min-w-[220px] flex items-center rounded-lg bg-black/40 border border-white/10 px-3 font-mono text-sm text-white/85 overflow-x-auto whitespace-nowrap">
                  {keyDisplay}
                </div>
                {isAdmin && (
                  <Button onClick={revealKey} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2 shrink-0">
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />} {showKey ? "Ocultar" : "Mostrar"}
                  </Button>
                )}
                {isAdmin && showKey && revealedKey && (
                  <Button onClick={() => copy(revealedKey, "Clave copiada")} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2 shrink-0">
                    {copied === "Clave copiada" ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />} Copiar
                  </Button>
                )}
                {isAdmin && (
                  <Button onClick={regenerateKey} disabled={regenerating} variant="outline" className="border-red-500/25 bg-red-500/8 hover:bg-red-500/15 text-red-300 gap-2 shrink-0">
                    {regenerating ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Regenerar
                  </Button>
                )}
              </div>
              {!isAdmin && <p className="text-[11px] text-white/30">Solo un administrador puede ver, copiar o regenerar la clave.</p>}
            </div>

            {/* IP manual */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/85">IP del servidor (opcional)</Label>
                <Input
                  value={String(s.rtmpHost ?? "")}
                  onChange={(e) => set("rtmpHost", e.target.value.trim())}
                  placeholder={`Detectada automáticamente (${rtmpInfo?.host ?? ""})`}
                  className="bg-white/[0.04] border-white/10 font-mono text-sm"
                />
                <p className="text-[11px] text-white/30">Déjalo vacío para autodetectar la IP de la LAN. Guárdalo solo si la IP cambia o hay varias tarjetas de red.</p>
              </div>
            </div>

            {/* Guía paso a paso OBS */}
            <div className="rounded-xl border border-white/10 bg-black/25 p-4 space-y-3">
              <div className="font-semibold text-white text-sm flex items-center gap-2">
                <MonitorPlay size={15} className="text-amber-400" /> Cómo conectar OBS Studio (una sola vez)
              </div>
              <ol className="space-y-2 text-[13px] text-white/60">
                <li className="flex gap-2.5"><Step n={1} /> <span>Abre <b className="text-white/85">OBS Studio</b> en cualquier computadora de tu red local.</span></li>
                <li className="flex gap-2.5"><Step n={2} /> <span>Ve a <b className="text-white/85">Configuración → Emisión</b> y elige Servicio: <b className="text-white/85">Personalizado…</b></span></li>
                <li className="flex gap-2.5"><Step n={3} /> <span>En <b className="text-white/85">Servidor</b>, pega la URL RTMP de arriba (botón Copiar).</span></li>
                <li className="flex gap-2.5"><Step n={4} /> <span>En <b className="text-white/85">Clave de transmisión</b>, pega la clave (Muéstrala y cópiala).</span></li>
                <li className="flex gap-2.5"><Step n={5} /> <span>Pulsa <b className="text-white/85">Aplicar</b> y luego <b className="text-white/85">Iniciar transmisión</b> — las pantallas pasan a <span className="text-red-400 font-semibold">EN VIVO</span> en segundos.</span></li>
              </ol>
              <div className="flex gap-2 items-center rounded-lg bg-emerald-500/8 border border-emerald-500/20 px-3 py-2">
                <ShieldCheck size={15} className="text-emerald-400 shrink-0" />
                <p className="text-xs text-emerald-200/70 leading-relaxed">
                  <b>100% local:</b> la transmisión nunca sale de tu red (LAN). La clave se valida en el servidor y nunca llega al navegador de las pantallas.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ====== CONFIGURACIÓN EXTERNA (modo externo) ====== */}
      {!isLocal && (
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white">Reproducción desde servidor externo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label className="text-white/85">URL del stream (HLS .m3u8 o video directo)</Label>
              <div className="flex gap-2">
                <Input
                  value={String(s.streamUrl ?? "")}
                  onChange={(e) => set("streamUrl", e.target.value)}
                  placeholder="https://tu-servidor.com/live/restaurante.m3u8"
                  className="bg-white/[0.04] border-white/10 font-mono text-sm"
                />
                <Button onClick={testStream} disabled={testing} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2 shrink-0">
                  {testing ? <Loader2 size={15} className="animate-spin" /> : <TestTube2 size={15} />} Probar
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={useDemo} className="text-amber-300/90 hover:text-amber-300 hover:bg-amber-400/10 h-7 text-xs gap-1.5">
                  <MonitorPlay size={13} /> Usar stream de demostración
                </Button>
                <span className="text-[11px] text-white/30">Mux test stream — requiere Internet.</span>
              </div>
              {testResult && (
                <div className={`text-xs rounded-lg px-3 py-2 border ${testResult.ok ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" : "bg-red-500/10 text-red-400 border-red-500/25"}`}>
                  {testResult.ok
                    ? `✓ ${testResult.details} · HTTP ${testResult.status} · ${testResult.latencyMs}ms`
                    : `✗ ${testResult.error ?? "No se pudo conectar"}`}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/85">Protocolo</Label>
                <Select value={String(s.streamProtocol ?? "hls")} onValueChange={(v) => set("streamProtocol", v)}>
                  <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hls">HLS (.m3u8) — recomendado</SelectItem>
                    <SelectItem value="mp4">Video directo (MP4/WebM)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-white/85">Comportamiento ante desconexión</Label>
                <Select value={String(s.reconnectBehavior ?? "auto")} onValueChange={(v) => set("reconnectBehavior", v)}>
                  <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Reconexión automática + fallback</SelectItem>
                    <SelectItem value="manual">Mostrar fallback sin reintentar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-white/85">Reproducción automática</Label>
                <p className="text-xs text-white/40 mt-0.5">Inicia la reproducción al abrir la pantalla (silenciado si el navegador lo exige).</p>
              </div>
              <Switch checked={Boolean(s.autoplay)} onCheckedChange={(v) => set("autoplay", v)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ====== ESTADO EN PANTALLAS ====== */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-white flex items-center gap-2"><Tv size={16} className="text-amber-400" /> Estado en pantallas</CardTitle>
        </CardHeader>
        <CardContent>
          {screensStatus.length === 0 ? (
            <p className="text-sm text-white/40">Ninguna pantalla conectada al realtime ahora mismo.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {screensStatus.map((sc) => (
                <div key={sc.screenCode} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-amber-300">{sc.screenCode}</span>
                  <span className="flex items-center gap-2 text-xs text-white/60">
                    {sc.streamInfo?.resolution && <span className="text-white/35">{sc.streamInfo.resolution}</span>}
                    {sc.streamInfo?.bitrate && <span className="text-white/35">{Math.round(sc.streamInfo.bitrate / 1000)} kbps</span>}
                    <StreamBadge state={sc.streamState} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ====== CONTENIDO DE RESPALDO ====== */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-white">Contenido de respaldo (fallback)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-white/50 -mt-1">Cuando OBS deja de transmitir, las pantallas muestran este contenido y vuelven automáticamente al vivo al reanudarse.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { id: "message", label: "Mensaje", desc: "Texto elegante" },
              { id: "image", label: "Imagen", desc: "Promocional" },
              { id: "video", label: "Video", desc: "En bucle" },
            ].map((o) => (
              <button
                key={o.id}
                onClick={() => set("fallbackType", o.id)}
                className={`rounded-xl border p-4 text-left transition-all ${s.fallbackType === o.id ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 hover:border-white/30"}`}
              >
                <div className="font-semibold text-white text-sm">{o.label}</div>
                <div className="text-xs text-white/40 mt-0.5">{o.desc}</div>
              </button>
            ))}
          </div>

          {s.fallbackType === "message" && (
            <div className="space-y-2">
              <Label className="text-white/85">Mensaje</Label>
              <Input value={String(s.fallbackMessage ?? "")} onChange={(e) => set("fallbackMessage", e.target.value)} className="bg-white/[0.04] border-white/10" />
            </div>
          )}
          {s.fallbackType === "image" && (
            <div className="space-y-2">
              <Label className="text-white/85">Imagen de respaldo</Label>
              <ImageUploadField value={s.fallbackImageUrl as string | null} onChange={(v) => set("fallbackImageUrl", v)} label="" />
            </div>
          )}
          {s.fallbackType === "video" && (
            <div className="space-y-2">
              <Label className="text-white/85">Video de respaldo</Label>
              <ImageUploadField value={s.fallbackVideoUrl as string | null} onChange={(v) => set("fallbackVideoUrl", v)} accept="video/mp4,video/webm,video/*,image/*" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Step({ n }: { n: number }) {
  return (
    <span className="shrink-0 w-5 h-5 rounded-full bg-amber-400/15 border border-amber-400/30 text-amber-300 text-[11px] font-bold flex items-center justify-center">
      {n}
    </span>
  )
}

function Stat({ label, value, icon, live }: { label: string; value: string; icon?: React.ReactNode; live?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-white/35 flex items-center gap-1">{icon} {label}</div>
      <div className={`font-mono text-sm mt-0.5 ${live ? "text-white/90" : "text-white/50"}`}>{value}</div>
    </div>
  )
}

function StreamBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    live: "bg-red-500/15 text-red-400",
    connecting: "bg-amber-500/15 text-amber-300",
    fallback: "bg-orange-500/15 text-orange-300",
    offline: "bg-zinc-500/15 text-zinc-500",
    disabled: "bg-zinc-500/15 text-zinc-500",
  }
  return <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${map[state] ?? map.offline}`}>{state.toUpperCase()}</span>
}

function Loading() {
  return (
    <div className="p-6 flex items-center justify-center min-h-[50vh]">
      <Loader2 size={28} className="animate-spin text-amber-400" />
    </div>
  )
}

function buildPatch(settings: Record<string, unknown>): Record<string, unknown> {
  const { _newStreamKey, ...rest } = settings as Record<string, unknown> & { _newStreamKey?: string }
  const patch = { ...rest }
  if (_newStreamKey) patch.streamKey = _newStreamKey
  else delete patch.streamKey
  delete (patch as Record<string, unknown>).streamKeyMasked
  delete (patch as Record<string, unknown>).hasStreamKey
  delete (patch as Record<string, unknown>).id
  delete (patch as Record<string, unknown>).updatedAt
  return patch
}
