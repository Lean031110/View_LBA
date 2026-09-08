"use client"

import { Loader2, Save, Store } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useSettings } from "../useSettings"
import ImageUploadField from "../ImageUploadField"

export default function BrandingSection(props: Record<string, unknown>) {
  const { settings, setSettings, saving, save } = useSettings()

  if (!settings) return <div className="p-6 flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
  const s = settings as Record<string, unknown>
  const set = (k: string, v: unknown) => setSettings({ ...settings, [k]: v } as Record<string, unknown>)

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Store size={22} className="text-amber-400" /> Logotipo y Marca</h1>
          <p className="text-white/45 text-sm mt-0.5">Identidad del restaurante en la cabecera de la pantalla</p>
        </div>
        <Button onClick={() => save({ restaurantName: s.restaurantName, logoUrl: s.logoUrl, logoSize: s.logoSize, logoPosition: s.logoPosition })} disabled={saving} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Guardar y publicar
        </Button>
      </div>

      <Card className="bg-white/[0.03] border-white/10">
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-2">
            <Label className="text-white/85">Nombre del restaurante</Label>
            <Input value={String(s.restaurantName ?? "")} onChange={(e) => set("restaurantName", e.target.value)} placeholder="La Terraza Grill & Bar" className="bg-white/[0.04] border-white/10" />
            <p className="text-xs text-white/35">Se muestra tipográficamente cuando no hay logo cargado (y en la etiqueta del ticker).</p>
          </div>

          <div className="space-y-2">
            <Label className="text-white/85">Logotipo</Label>
            <ImageUploadField value={s.logoUrl as string | null} onChange={(v) => set("logoUrl", v)} label="PNG transparente recomendado" aspect="aspect-[16/9]" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-white/85">Tamaño del logo</Label>
              <Select value={String(s.logoSize ?? "md")} onValueChange={(v) => set("logoSize", v)}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">Pequeño</SelectItem>
                  <SelectItem value="md">Mediano</SelectItem>
                  <SelectItem value="lg">Grande</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-white/85">Posición</Label>
              <Select value={String(s.logoPosition ?? "right")} onValueChange={(v) => set("logoPosition", v)}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="right">Derecha</SelectItem>
                  <SelectItem value="center">Centro</SelectItem>
                  <SelectItem value="left">Izquierda</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Vista previa */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-white/70">Vista previa de cabecera</CardTitle></CardHeader>
        <CardContent>
          <div className="rounded-xl border border-white/10 bg-[#0b0b0f] px-6 py-5 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-amber-400 font-bold tracking-widest text-xs">LUNES</span>
              <span className="text-white/60 text-xs">08 SEPTIEMBRE 2026</span>
              <span className="text-white text-3xl font-bold font-mono">11:55 AM</span>
            </div>
            {s.logoUrl ? (
              <img src={String(s.logoUrl)} alt="logo" className="h-16 object-contain" />
            ) : (
              <span className="text-2xl font-bold text-white">{String(s.restaurantName ?? "").toUpperCase()}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
