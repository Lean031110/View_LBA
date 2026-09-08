"use client"

import { useCallback, useEffect, useState } from "react"
import { Volume2, Loader2, Save, Send, Info, Speaker, MonitorPlay } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { useSettings } from "../useSettings"
import { getJSON, putJSON, patchJSON } from "../api"
import type { ScreenStatus } from "@/lib/types"

/**
 * FASE 7 (misión) — arquitectura de audio CORREGIDA:
 *
 * ANTES (incorrecto): el navegador del ADMIN enumeraba SUS dispositivos y
 * guardaba un deviceId global que las TVs aplicaban (el deviceId de una
 * máquina no existe en otra).
 *
 * AHORA: cada TV enumera sus PROPIOS dispositivos de salida y los reporta
 * vía realtime (screen:audio). El admin elige la salida POR PANTALLA de esa
 * lista reportada (TV-001 → HDMI, TV-002 → Predeterminada…). La selección
 * persiste en Screen.audioDeviceId y se aplica en vivo al guardar.
 * La TV aplica setSinkId si su navegador lo soporta; si no, usa la salida
 * predeterminada del sistema sin romper la reproducción.
 */

interface ScreenRow {
  id: string
  code: string
  name: string
  active: boolean
  audioDeviceId: string | null
  online?: boolean
  audioInfo?: ScreenStatus["audioInfo"]
}

export default function AudioSection({
  sendCommand,
  screensStatus,
}: {
  user: { name: string; role: string }
  screensStatus: ScreenStatus[]
  realtimeConnected: boolean
  sendCommand: (t: string, p?: Record<string, unknown>, s?: string) => void
  section: string
  setSection: (s: string) => void
}) {
  const { settings, setSettings, saving, save } = useSettings()
  const { toast } = useToast()
  const [screens, setScreens] = useState<ScreenRow[] | null>(null)
  const [applying, setApplying] = useState<string | null>(null)

  const load = useCallback(() => {
    getJSON<{ items: ScreenRow[] }>("/api/admin/screens")
      .then((d) => setScreens(d.items))
      .catch(() => setScreens([]))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Fusionar dispositivos reportados EN VIVO (realtime) con la lista de la DB
  const liveByCode = new Map(screensStatus.map((s) => [s.screenCode, s]))
  const mergedScreens = (screens ?? []).map((sc) => ({
    ...sc,
    audioInfo: liveByCode.get(sc.code)?.audioInfo ?? sc.audioInfo ?? null,
    online: liveByCode.get(sc.code)?.online ?? sc.online ?? false,
  }))

  if (!settings) return <div className="p-6 flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
  const s = settings as Record<string, unknown>
  const set = (k: string, v: unknown) => setSettings({ ...settings, [k]: v } as Record<string, unknown>)

  /** Volumen/mute globales → aplicar AHORA en todas las pantallas conectadas */
  const applyNow = async () => {
    setApplying("global")
    try {
      await patchJSON("/api/admin/screens", {
        command: "audio",
        payload: { volume: Number(s.audioVolume ?? 80), muted: Boolean(s.audioMuted ?? true) },
      })
      toast({ title: "Comando enviado", description: "Las pantallas conectadas aplican volumen/silencio de inmediato." })
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally {
      setApplying(null)
    }
  }

  /** Salida de audio de UNA pantalla → persistir + aplicar en vivo (a esa TV) */
  const saveScreenAudio = async (screen: ScreenRow, deviceId: string | null) => {
    setApplying(screen.id)
    try {
      await putJSON(`/api/admin/screens/${screen.id}`, { audioDeviceId: deviceId })
      setScreens((prev) => prev?.map((sc) => (sc.id === screen.id ? { ...sc, audioDeviceId: deviceId } : sc)) ?? null)
      toast({
        title: `${screen.code} actualizada`,
        description: deviceId ? "Salida aplicada en la pantalla al instante." : "Vuelve a la salida predeterminada del sistema.",
      })
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally {
      setApplying(null)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Volume2 size={22} className="text-amber-400" /> Audio</h1>
          <p className="text-white/45 text-sm mt-0.5">Volumen global y salida de sonido por pantalla</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={applyNow} disabled={applying === "global"} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
            {applying === "global" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Aplicar volumen ahora
          </Button>
          <Button onClick={() => save({ audioVolume: s.audioVolume, audioMuted: s.audioMuted, audioAutoUnmute: s.audioAutoUnmute })} disabled={saving} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Guardar
          </Button>
        </div>
      </div>

      {/* ---- Volumen / silencio globales ---- */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardContent className="space-y-6 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-white/85">Silencio global (mute)</Label>
              <p className="text-xs text-white/40 mt-0.5">El video se reproduce sin sonido en las pantallas.</p>
            </div>
            <Switch checked={Boolean(s.audioMuted ?? true)} onCheckedChange={(v) => set("audioMuted", v)} />
          </div>

          <div className="space-y-2.5">
            <div className="flex justify-between">
              <Label className="text-white/85">Volumen</Label>
              <span className="text-xs text-amber-300 font-mono">{Number(s.audioVolume ?? 80)}%</span>
            </div>
            <Slider value={[Number(s.audioVolume ?? 80)]} min={0} max={100} step={5} onValueChange={([v]) => set("audioVolume", v)} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-white/85">Reactivar audio automáticamente</Label>
              <p className="text-xs text-white/40 mt-0.5">Intenta activar el sonido al recuperar la transmisión (respetando políticas del navegador).</p>
            </div>
            <Switch checked={Boolean(s.audioAutoUnmute)} onCheckedChange={(v) => set("audioAutoUnmute", v)} />
          </div>
        </CardContent>
      </Card>

      {/* ---- Salida de audio POR PANTALLA (arquitectura FASE 7) ---- */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-white/70 flex items-center gap-2">
            <Speaker size={14} className="text-white/40" /> Salida de audio por pantalla
          </CardTitle>
          <p className="text-xs text-white/40 leading-relaxed mt-1">
            Cada televisor reporta sus propias salidas de sonido (HDMI, altavoces, auriculares…) nada más conectarse.
            Elige para cada una la salida deseada: se aplica al instante y queda guardada para sus reinicios.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {mergedScreens === null ? (
            <div className="flex justify-center py-8"><Loader2 size={22} className="animate-spin text-amber-400" /></div>
          ) : mergedScreens.length === 0 ? (
            <p className="text-xs text-white/40 py-2">No hay pantallas configuradas. Crea pantallas en la sección «Pantallas».</p>
          ) : (
            mergedScreens.map((sc) => {
              const devices = sc.audioInfo?.devices ?? []
              const supportsSinkId = sc.audioInfo?.supportsSinkId
              const isApplying = applying === sc.id
              return (
                <div key={sc.id} className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <MonitorPlay size={14} className="text-amber-300/70 shrink-0" />
                      <span className="font-mono text-xs text-amber-300">{sc.code}</span>
                      <span className="text-sm text-white/80 truncate">{sc.name}</span>
                      <Badge variant="outline" className={`text-[10px] font-bold ${sc.online ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" : "text-zinc-500 border-zinc-500/30 bg-zinc-500/10"}`}>
                        {sc.online ? "● EN LÍNEA" : "OFFLINE"}
                      </Badge>
                    </div>
                    {supportsSinkId === false && (
                      <Badge variant="outline" className="text-[10px] text-amber-300/80 border-amber-500/25 bg-amber-500/10">
                        salida específica no compatible — usará la predeterminada
                      </Badge>
                    )}
                  </div>

                  {!sc.audioInfo ? (
                    <p className="text-[11px] text-white/35">
                      {sc.online
                        ? "Esperando el reporte de dispositivos de esta pantalla…"
                        : "Pantalla desconectada: se aplicará cuando se conecte (se guardará de todos modos)."}
                    </p>
                  ) : devices.length === 0 ? (
                    <p className="text-[11px] text-white/35">Esta pantalla no reporta dispositivos de salida.</p>
                  ) : (
                    <div className="flex items-center gap-3 flex-wrap">
                      <Select
                        value={sc.audioDeviceId ?? "default"}
                        onValueChange={(v) => saveScreenAudio(sc, v === "default" ? null : v)}
                        disabled={isApplying}
                      >
                        <SelectTrigger className="bg-white/[0.04] border-white/10 flex-1 min-w-[220px]">
                          <SelectValue placeholder="Salida predeterminada del sistema" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Salida predeterminada del sistema</SelectItem>
                          {devices.map((d) => (
                            <SelectItem key={d.deviceId} value={d.deviceId}>{d.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isApplying && <Loader2 size={14} className="animate-spin text-amber-400" />}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-white/70 flex items-center gap-2"><Info size={14} className="text-white/40" /> Cómo funciona</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-white/45 leading-relaxed space-y-1.5">
          <p>
            La lista de salidas de cada pantalla la reporta <b className="text-white/70">el propio televisor</b> desde su navegador
            (no se pueden cruzar deviceIds entre equipos). Si una TV no permite elegir salida (Firefox/Safari/algunos Smart TV),
            usará la configurada en su sistema y se indica aquí.
          </p>
          <p>
            Los navegadores bloquean el sonido automático sin interacción. En modo kiosco
            (<code className="text-amber-300/80 bg-white/5 px-1 rounded">--autoplay-policy=no-user-gesture-required</code> o Android TV)
            funciona desde el arranque; si no, el control de volumen del reproductor lo activa con un toque.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
