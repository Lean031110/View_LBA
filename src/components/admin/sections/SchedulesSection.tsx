"use client"

import { useEffect, useState } from "react"
import { Clock, Plus, Pencil, Trash2, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"
import type { ScheduleDTO } from "@/lib/types"

const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
const ICONS = [
  { id: "", label: "Sin icono" }, { id: "coffee", label: "Café ☕" }, { id: "croissant", label: "Croissant" },
  { id: "sun", label: "Sol" }, { id: "soup", label: "Sopa" }, { id: "utensils", label: "Cubiertos" },
  { id: "wine", label: "Vino" }, { id: "moon", label: "Luna" }, { id: "star", label: "Estrella" },
  { id: "sparkles", label: "Destellos" },
]

interface FormState { name: string; startTime: string; endTime: string; dayOfWeek: string; icon: string; color: string; order: number; active: boolean }
const emptyForm: FormState = { name: "", startTime: "07:00", endTime: "11:00", dayOfWeek: "", icon: "coffee", color: "#f5a623", order: 1, active: true }

export default function SchedulesSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<ScheduleDTO[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const load = () => getJSON<{ items: ScheduleDTO[] }>("/api/admin/schedules").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const submit = async () => {
    if (!form.name.trim() || !form.startTime || !form.endTime) return toast({ title: "Nombre y horarios requeridos", variant: "destructive" })
    setBusy(true)
    try {
      const body = { ...form, dayOfWeek: form.dayOfWeek === "" ? null : Number(form.dayOfWeek) }
      if (editing) await putJSON(`/api/admin/schedules/${editing}`, body)
      else await postJSON("/api/admin/schedules", body)
      toast({ title: "Horario guardado", description: "La franja HORARIO DE HOY se actualiza al instante." })
      setOpen(false)
      load()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally { setBusy(false) }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Clock size={22} className="text-amber-400" /> Horarios</h1>
          <p className="text-white/45 text-sm mt-0.5">Franja “HORARIO DE HOY” — el turno activo se destaca automáticamente</p>
        </div>
        <Button onClick={() => { setForm({ ...emptyForm, order: (items?.length ?? 0) + 1 }); setEditing(null); setOpen(true) }} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          <Plus size={16} /> Nuevo horario
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <Card key={s.id} className={`bg-white/[0.03] border-white/10 ${!s.active ? "opacity-50" : ""}`}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-bold text-white tracking-wide">{s.name}</div>
                    <div className="text-sm text-amber-300 font-mono font-semibold mt-1">{s.startTime} – {s.endTime}</div>
                    <div className="text-[11px] text-white/35 mt-1">
                      {s.dayOfWeek != null ? DAYS[s.dayOfWeek] : "Todos los días"} · orden {s.order}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <Switch checked={s.active} onCheckedChange={async (v) => { await putJSON(`/api/admin/schedules/${s.id}`, { active: v }).catch(() => {}); load() }} />
                    <Button size="icon" variant="ghost" onClick={() => { setForm({ name: s.name, startTime: s.startTime, endTime: s.endTime, dayOfWeek: s.dayOfWeek?.toString() ?? "", icon: s.icon ?? "", color: s.color ?? "#f5a623", order: s.order, active: s.active }); setEditing(s.id); setOpen(true) }} className="h-7 w-7 text-white/60 hover:text-white"><Pencil size={13} /></Button>
                    <Button size="icon" variant="ghost" onClick={async () => { if (confirm(`¿Eliminar ${s.name}?`)) { await deleteJSON(`/api/admin/schedules/${s.id}`).catch(() => {}); load() } }} className="h-7 w-7 text-white/60 hover:text-red-400"><Trash2 size={13} /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-lg">
          <DialogHeader><DialogTitle className="text-white">{editing ? "Editar horario" : "Nuevo horario"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Nombre *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="DESAYUNO" className="bg-white/[0.04] border-white/10 uppercase" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Inicio *</Label>
              <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Fin *</Label>
              <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Día</Label>
              <Select value={form.dayOfWeek} onValueChange={(v) => setForm({ ...form, dayOfWeek: v })}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue placeholder="Todos los días" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Todos los días</SelectItem>
                  {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Icono</Label>
              <Select value={form.icon} onValueChange={(v) => setForm({ ...form, icon: v })}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ICONS.map((i) => <SelectItem key={i.id} value={i.id || "none"}>{i.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Color de acento</Label>
              <div className="flex gap-2 items-center">
                <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-12 h-9 rounded-lg bg-transparent border border-white/15 cursor-pointer" />
                <Input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="bg-white/[0.04] border-white/10 font-mono text-sm flex-1" />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Orden</Label>
              <Input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5">
              <Label className="text-white/85">Activo</Label>
              <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/15 bg-transparent hover:bg-white/5">Cancelar</Button>
            <Button onClick={submit} disabled={busy} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
              {busy && <Loader2 size={15} className="animate-spin" />} Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
