"use client"

import { useEffect, useRef, useState } from "react"
import { Volume2, Loader2, Save, Send, Info, Speaker } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { useSettings } from "../useSettings"

interface AudioDevice { deviceId: string; label: string }

export default function AudioSection({
  sendCommand,
  screensStatus,
}: {
  user: { name: string; role: string }
  screensStatus: unknown[]
  realtimeConnected: boolean
  sendCommand: (t: string, p?: Record<string, unknown>, s?: string) => void
  section: string
  setSection: (s: string) => void
}) {
  const { settings, setSettings, saving, save } = useSettings()
  const { toast } = useToast()
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [supported, setSupported] = useState<boolean | null>(null)
  const [sending, setSending] = useState(false)
  const probeRef = useRef<HTMLAudioElement | null>(null)

  // Detectar soporte de selección de dispositivo de salida (setSinkId — Chrome/Edge/Opera)
  // Se hace en callback asíncrono (rAF) para evitar renders en cascada tras el montaje
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = document.createElement("audio")
      const ok = typeof (el as HTMLAudioElement & { setSinkId?: unknown }).setSinkId === "function"
      setSupported(ok)
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // Enumerar dispositivos de salida (requiere permiso para etiquetas)
  const listDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
      const all = await navigator.mediaDevices.enumerateDevices()
      const outs = all.filter((d) => d.kind === "audiooutput").map((d) => ({ deviceId: d.deviceId, label: d.label || `Dispositivo ${d.deviceId.slice(0, 6)}` }))
      setDevices(outs)
      stream?.getTracks().forEach((t) => t.stop())
      if (outs.length === 0) toast({ title: "Sin dispositivos detectados", description: "Conecta/activa altavoces o HDMI y reintenta." })
    } catch {
      setDevices([])
    }
  }

  if (!settings) return <div className="p-6 flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
  const s = settings as Record<string, unknown>
  const set = (k: string, v: unknown) => setSettings({ ...settings, [k]: v } as Record<string, unknown>)

  const applyNow = () => {
    setSending(true)
    sendCommand("audio", { volume: Number(s.audioVolume ?? 80), muted: Boolean(s.audioMuted), deviceId: s.audioDeviceId ?? null })
    toast({ title: "Comando enviado", description: "Las pantallas conectadas aplican el audio de inmediato." })
    setTimeout(() => setSending(false), 800)
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Volume2 size={22} className="text-amber-400" /> Audio</h1>
          <p className="text-white/45 text-sm mt-0.5">Configuración de sonido de las pantallas TV</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={applyNow} disabled={sending} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Aplicar ahora
          </Button>
          <Button onClick={() => save({ audioVolume: s.audioVolume, audioMuted: s.audioMuted, audioDeviceId: s.audioDeviceId, audioAutoUnmute: s.audioAutoUnmute })} disabled={saving} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Guardar
          </Button>
        </div>
      </div>

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

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-white/85">Dispositivo de salida</Label>
              <Button size="sm" variant="outline" onClick={listDevices} className="border-white/15 bg-white/[0.03] hover:bg-white/10 h-7 text-xs gap-1.5">
                <Speaker size={12} /> Detectar dispositivos
              </Button>
            </div>
            {supported === null ? null : supported ? (
              <Select value={String(s.audioDeviceId ?? "default")} onValueChange={(v) => set("audioDeviceId", v === "default" ? null : v)}>
                <SelectTrigger className="bg-white/[0.04] border-white/10">
                  <SelectValue placeholder="Salida predeterminada del sistema" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Salida predeterminada del sistema</SelectItem>
                  {devices.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex gap-2 items-center rounded-lg bg-amber-500/8 border border-amber-500/20 px-3 py-2.5">
                <Info size={14} className="text-amber-400 shrink-0" />
                <p className="text-xs text-amber-200/70 leading-relaxed">
                  Este navegador no permite elegir el dispositivo de salida (Firefox/Safari). La pantalla usará la salida
                  configurada en el sistema del TV/minipc — ajústala en el volumen del sistema operativo.
                </p>
              </div>
            )}
            {supported && devices.length === 0 && (
              <p className="text-[11px] text-white/30">Pulsa “Detectar dispositivos”. El navegador puede pedir permiso de micrófono para mostrar los nombres (requisito de seguridad de Chrome).</p>
            )}
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

      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-white/70 flex items-center gap-2"><Info size={14} className="text-white/40" /> Nota sobre autoplay</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/45 leading-relaxed">
            Los navegadores bloquean sonido automático sin interacción del usuario. En modo kiosco (Chrome con la flag{" "}
            <code className="text-amber-300/80 bg-white/5 px-1 rounded">--autoplay-policy=no-user-gesture-required</code>{" "}
            o Android TV) el audio funciona desde el arranque. En pantallas normales, el control de volumen de la
            esquina del reproductor activa el sonido con un toque.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
