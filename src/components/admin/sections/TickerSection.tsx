"use client"

import { useEffect, useState } from "react"
import { Newspaper, Plus, Trash2, Loader2, Save, Play, Pause } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"
import { useSettings } from "../useSettings"
import type { TickerMessageDTO } from "@/lib/types"

export default function TickerSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<TickerMessageDTO[] | null>(null)
  const [newText, setNewText] = useState("")
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const { settings, setSettings, saving, save } = useSettings()

  const load = () => getJSON<{ items: TickerMessageDTO[] }>("/api/admin/ticker").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const add = async () => {
    if (!newText.trim()) return
    setBusy(true)
    try {
      await postJSON("/api/admin/ticker", { text: newText, order: (items?.length ?? 0) + 1, active: true })
      setNewText("")
      load()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally { setBusy(false) }
  }

  const s = settings as Record<string, unknown> | null

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Newspaper size={22} className="text-amber-400" /> Ticker</h1>
        <p className="text-white/45 text-sm mt-0.5">Franja blanca inferior — texto en movimiento continuo (izquierda → derecha)</p>
      </div>

      {/* Comportamiento */}
      {s && (
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white">Comportamiento del ticker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-white/85">Ticker visible</Label>
                <p className="text-xs text-white/40 mt-0.5">Muestra u oculta la franja en las pantallas.</p>
              </div>
              <Switch checked={Boolean(s.tickerEnabled)} onCheckedChange={(v) => setSettings!({ ...settings!, tickerEnabled: v } as Record<string, unknown>)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-white/85">Pausado</Label>
                <p className="text-xs text-white/40 mt-0.5">Congela el desplazamiento del texto.</p>
              </div>
              <Switch checked={Boolean(s.tickerPaused)} onCheckedChange={(v) => setSettings!({ ...settings!, tickerPaused: v } as Record<string, unknown>)} />
            </div>
            <div className="space-y-2.5">
              <div className="flex justify-between">
                <Label className="text-white/85">Velocidad</Label>
                <span className="text-xs text-amber-300 font-mono">{Number(s.tickerSpeed ?? 55)} px/s</span>
              </div>
              <Slider
                value={[Number(s.tickerSpeed ?? 55)]}
                min={15}
                max={150}
                step={5}
                onValueChange={([v]) => setSettings!({ ...settings!, tickerSpeed: v } as Record<string, unknown>)}
              />
              <p className="text-[11px] text-white/35">Recomendado: 40–70 px/s para lectura cómoda a distancia.</p>
            </div>
            <Button
              onClick={() => save({ tickerEnabled: s.tickerEnabled, tickerPaused: s.tickerPaused, tickerSpeed: s.tickerSpeed })}
              disabled={saving}
              className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Publicar ajustes
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Mensajes */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-white">Mensajes ({items?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Ej.: Happy Hour de 17:00 a 19:00"
              className="bg-white/[0.04] border-white/10"
            />
            <Button onClick={add} disabled={busy || !newText.trim()} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-1.5 shrink-0">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Añadir
            </Button>
          </div>

          {items === null ? (
            <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-amber-400" /></div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto custom-scrollbar pr-1">
              {items.map((m, i) => (
                <div key={m.id} className={`flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 ${!m.active ? "opacity-50" : ""}`}>
                  <span className="text-xs text-white/25 font-mono w-6 shrink-0">{i + 1}</span>
                  <Input
                    defaultValue={m.text}
                    onBlur={async (e) => {
                      if (e.target.value !== m.text) {
                        await putJSON(`/api/admin/ticker/${m.id}`, { text: e.target.value }).catch(() => {})
                        load()
                      }
                    }}
                    className="bg-transparent border-transparent hover:border-white/10 focus:bg-white/[0.04] h-8 text-sm"
                  />
                  <Button size="icon" variant="ghost" onClick={async () => { await putJSON(`/api/admin/ticker/${m.id}`, { active: !m.active }).catch(() => {}); load() }} className="h-7 w-7 shrink-0 text-white/60 hover:text-white" title={m.active ? "Ocultar" : "Mostrar"}>
                    {m.active ? <Pause size={13} /> : <Play size={13} />}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={async () => { if (confirm("¿Eliminar este mensaje?")) { await deleteJSON(`/api/admin/ticker/${m.id}`).catch(() => {}); load() } }} className="h-7 w-7 shrink-0 text-white/60 hover:text-red-400">
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-white/30">Edita cualquier mensaje directamente; los cambios se publican al salir del campo.</p>
        </CardContent>
      </Card>
    </div>
  )
}
