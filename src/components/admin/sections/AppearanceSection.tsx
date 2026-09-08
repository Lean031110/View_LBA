"use client"

import { useState } from "react"
import { Palette, Loader2, Save, Eye, RotateCcw, Timer, Type } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { useSettings } from "../useSettings"
import Link from "next/link"

const PRESETS = [
  { name: "Ámbar Premium", primary: "#f5a623", accent: "#e8452c", bg: "#0b0b0f", surface: "#15151b" },
  { name: "Rojo Brasserie", primary: "#e63946", accent: "#f5a623", bg: "#0d0507", surface: "#1b0f12" },
  { name: "Verde Bistró", primary: "#5ec269", accent: "#f5a623", bg: "#071009", surface: "#0f1b12" },
  { name: "Oro Elegante", primary: "#d4af37", accent: "#a32638", bg: "#0f0c07", surface: "#1a150c" },
]

export default function AppearanceSection(props: Record<string, unknown>) {
  const { settings, setSettings, saving, save } = useSettings()
  const { toast } = useToast()

  if (!settings) return <div className="p-6 flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
  const s = settings as Record<string, unknown>
  const set = (k: string, v: unknown) => setSettings({ ...settings, [k]: v } as Record<string, unknown>)

  const patch = () => ({
    primaryColor: s.primaryColor, accentColor: s.accentColor, bgColor: s.bgColor, surfaceColor: s.surfaceColor,
    fontScale: Number(s.fontScale), streamRatio: Number(s.streamRatio), animationsEnabled: s.animationsEnabled,
    animationSpeed: Number(s.animationSpeed), showPromotions: s.showPromotions, showDish: s.showDish,
    showSocials: s.showSocials, showSchedule: s.showSchedule, showTicker: s.showTicker,
    clockFormat: s.clockFormat, showDate: s.showDate, showSeconds: s.showSeconds, showDay: s.showDay,
    timezone: s.timezone,
  })

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Palette size={22} className="text-amber-400" /> Apariencia</h1>
          <p className="text-white/45 text-sm mt-0.5">Tema, proporciones y módulos visibles de la pantalla TV</p>
        </div>
        <div className="flex gap-2">
          <Link href="/?view=tv" target="_blank">
            <Button variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
              <Eye size={15} /> Vista previa
            </Button>
          </Link>
          <Button onClick={() => save(patch())} disabled={saving} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Guardar y publicar
          </Button>
        </div>
      </div>

      {/* Tema */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3"><CardTitle className="text-base text-white">Tema y colores</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {PRESETS.map((p) => {
              const active = p.primary === s.primaryColor && p.bg === s.bgColor
              return (
                <button
                  key={p.name}
                  onClick={() => { set("primaryColor", p.primary); set("accentColor", p.accent); set("bgColor", p.bg); set("surfaceColor", p.surface) }}
                  className={`rounded-xl border p-3 text-left transition-all ${active ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 hover:border-white/30"}`}
                >
                  <div className="flex gap-1.5 mb-2">
                    <span className="w-5 h-5 rounded-md" style={{ background: p.primary }} />
                    <span className="w-5 h-5 rounded-md" style={{ background: p.accent }} />
                    <span className="w-5 h-5 rounded-md border border-white/20" style={{ background: p.bg }} />
                  </div>
                  <div className="text-xs font-semibold text-white">{p.name}</div>
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {([["primaryColor", "Primario"], ["accentColor", "Acento"], ["bgColor", "Fondo"], ["surfaceColor", "Paneles"]] as const).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label className="text-white/80 text-xs">{label}</Label>
                <div className="flex gap-2 items-center">
                  <input type="color" value={String(s[key] ?? "#000000")} onChange={(e) => set(key, e.target.value)} className="w-9 h-8 rounded-lg bg-transparent border border-white/15 cursor-pointer" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Tipografía y proporciones */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3"><CardTitle className="text-base text-white flex items-center gap-2"><Type size={15} className="text-white/40" /> Tipografía y proporciones</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2.5">
            <div className="flex justify-between">
              <Label className="text-white/85 flex items-center gap-1.5"><Type size={13} className="text-white/40" /> Escala de fuente</Label>
              <span className="text-xs text-amber-300 font-mono">{Number(s.fontScale ?? 1).toFixed(2)}×</span>
            </div>
            <Slider value={[Number(s.fontScale ?? 1)]} min={0.7} max={1.6} step={0.05} onValueChange={([v]) => set("fontScale", v)} />
            <p className="text-[11px] text-white/35">Aumenta para TVs muy grandes (72"+) vistas a distancia.</p>
          </div>
          <div className="space-y-2.5">
            <div className="flex justify-between">
              <Label className="text-white/85">Proporción de la transmisión</Label>
              <span className="text-xs text-amber-300 font-mono">{Math.round(Number(s.streamRatio ?? 0.62) * 100)}%</span>
            </div>
            <Slider value={[Number(s.streamRatio ?? 0.62)]} min={0.5} max={0.8} step={0.02} onValueChange={([v]) => set("streamRatio", v)} />
            <div className="h-4 rounded-lg border border-white/10 overflow-hidden flex">
              <div style={{ width: `${(1 - Number(s.streamRatio ?? 0.62)) * 100}%`, background: "rgba(255,255,255,0.12)" }} />
              <div style={{ width: `${Number(s.streamRatio ?? 0.62) * 100}%`, background: "var(--primary, #f5a623)" }} />
            </div>
            <p className="text-[11px] text-white/35">Cuánto ancho ocupa el video frente a promociones/plato.</p>
          </div>
        </CardContent>
      </Card>

      {/* Animaciones */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3"><CardTitle className="text-base text-white flex items-center gap-2"><Timer size={15} className="text-white/40" /> Animaciones</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-white/85">Animaciones activadas</Label>
              <p className="text-xs text-white/40 mt-0.5">Transiciones del carrusel, redes y ticker.</p>
            </div>
            <Switch checked={Boolean(s.animationsEnabled)} onCheckedChange={(v) => set("animationsEnabled", v)} />
          </div>
          <div className="space-y-2.5">
            <div className="flex justify-between">
              <Label className="text-white/85">Velocidad de animación</Label>
              <span className="text-xs text-amber-300 font-mono">{Number(s.animationSpeed ?? 1).toFixed(2)}×</span>
            </div>
            <Slider value={[Number(s.animationSpeed ?? 1)]} min={0.5} max={2} step={0.1} onValueChange={([v]) => set("animationSpeed", v)} disabled={!s.animationsEnabled} />
          </div>
        </CardContent>
      </Card>

      {/* Módulos visibles */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3"><CardTitle className="text-base text-white">Módulos visibles en la pantalla</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {([["showPromotions", "Promociones"], ["showDish", "Plato del día"], ["showSchedule", "Horario del día"], ["showSocials", "Redes sociales"], ["showTicker", "Ticker"]] as const).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
                <Label className="text-white/85 text-sm">{label}</Label>
                <Switch checked={Boolean(s[key])} onCheckedChange={(v) => set(key, v)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Reloj */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3"><CardTitle className="text-base text-white">Reloj</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-white/85">Formato de hora</Label>
              <Select value={String(s.clockFormat ?? "12")} onValueChange={(v) => set("clockFormat", v)}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="12">12 horas (AM/PM)</SelectItem>
                  <SelectItem value="24">24 horas</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-white/85">Zona horaria</Label>
              <Select value={String(s.timezone ?? "America/Havana")} onValueChange={(v) => set("timezone", v)}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {TIMEZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {([["showDay", "Día de la semana"], ["showDate", "Fecha"], ["showSeconds", "Segundos"]] as const).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
              <Label className="text-white/85 text-sm">{label}</Label>
              <Switch checked={Boolean(s[key])} onCheckedChange={(v) => set(key, v)} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

const TIMEZONES = [
  "America/Havana", "America/Mexico_City", "America/Bogota", "America/Lima", "America/Santiago",
  "America/Buenos_Aires", "America/Sao_Paulo", "America/New_York", "America/Los_Angeles",
  "Europe/Madrid", "Europe/London", "Europe/Paris", "UTC",
]
