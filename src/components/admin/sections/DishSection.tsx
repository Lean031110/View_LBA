"use client"

import { useEffect, useState } from "react"
import { ChefHat, Plus, Pencil, Trash2, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"
import ImageUploadField from "../ImageUploadField"
import type { DishDTO } from "@/lib/types"

const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]

interface FormState {
  name: string; description: string; price: string; imageUrl: string | null
  ingredients: string; tag: string; nutrition: string
  dayOfWeek: string; date: string; order: number; active: boolean
}
const emptyForm: FormState = { name: "", description: "", price: "", imageUrl: null, ingredients: "", tag: "", nutrition: "", dayOfWeek: "", date: "", order: 0, active: true }

export default function DishSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<DishDTO[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const load = () => getJSON<{ items: DishDTO[] }>("/api/admin/dish").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const submit = async () => {
    if (!form.name.trim()) return toast({ title: "Nombre requerido", variant: "destructive" })
    setBusy(true)
    try {
      const body = { ...form, dayOfWeek: form.dayOfWeek === "" ? null : Number(form.dayOfWeek), date: form.date || null }
      if (editing) await putJSON(`/api/admin/dish/${editing}`, body)
      else await postJSON("/api/admin/dish", body)
      toast({ title: "Plato guardado", description: "Actualizado en pantallas en segundos." })
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
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><ChefHat size={22} className="text-amber-400" /> Plato del Día</h1>
          <p className="text-white/45 text-sm mt-0.5">Sugerencia destacada — programable por día o fecha</p>
        </div>
        <Button onClick={() => { setForm({ ...emptyForm, order: (items?.length ?? 0) + 1 }); setEditing(null); setOpen(true) }} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          <Plus size={16} /> Nuevo plato
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : items.length === 0 ? (
        <Card className="bg-white/[0.03] border-white/10"><CardContent className="py-12 text-center text-white/40 text-sm">Sin platos configurados.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((d) => (
            <Card key={d.id} className={`bg-white/[0.03] border-white/10 ${!d.active ? "opacity-50" : ""}`}>
              <CardContent className="py-4 flex gap-4">
                {d.imageUrl ? <img src={d.imageUrl} alt="" className="w-24 h-24 rounded-xl object-cover border border-white/10 shrink-0" /> : <div className="w-24 h-24 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0"><ChefHat size={20} className="text-white/20" /></div>}
                <div className="min-w-0 flex-1 flex flex-col">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white truncate">{d.name}</span>
                    {d.tag && <span className="text-[10px] font-bold text-red-400 bg-red-400/10 border border-red-400/25 rounded px-1.5 py-0.5">{d.tag}</span>}
                  </div>
                  <span className="text-sm text-amber-300 font-semibold mt-0.5">{d.price}</span>
                  <p className="text-xs text-white/40 line-clamp-2 mt-0.5">{d.description}</p>
                  <p className="text-[11px] text-white/30 mt-auto pt-1.5">
                    {d.dayOfWeek != null ? `${DAYS[d.dayOfWeek]} · ` : d.date ? `${d.date.slice(0, 10)} · ` : "Todos los días · "}
                    orden {d.order}
                  </p>
                  <div className="flex items-center gap-1 mt-1 -ml-2">
                    <Switch checked={d.active} onCheckedChange={async (v) => { await putJSON(`/api/admin/dish/${d.id}`, { active: v }).catch(() => {}); load() }} />
                    <Button size="icon" variant="ghost" onClick={() => {
                      setForm({ name: d.name, description: d.description ?? "", price: d.price ?? "", imageUrl: d.imageUrl, ingredients: d.ingredients ?? "", tag: d.tag ?? "", nutrition: d.nutrition ?? "", dayOfWeek: d.dayOfWeek?.toString() ?? "", date: d.date?.slice(0, 10) ?? "", order: d.order, active: d.active })
                      setEditing(d.id); setOpen(true)
                    }} className="h-7 w-7 text-white/60 hover:text-white"><Pencil size={13} /></Button>
                    <Button size="icon" variant="ghost" onClick={async () => { if (confirm(`¿Eliminar "${d.name}"?`)) { await deleteJSON(`/api/admin/dish/${d.id}`).catch(() => {}); load() } }} className="h-7 w-7 text-white/60 hover:text-red-400"><Trash2 size={13} /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader><DialogTitle className="text-white">{editing ? "Editar plato" : "Nuevo plato"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Nombre *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="CLUB SANDWICH" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Descripción</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Pan artesanal, pollo, bacon…" className="bg-white/[0.04] border-white/10 resize-none" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Precio</Label>
              <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="$450" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Etiqueta</Label>
              <Input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} placeholder="RECOMENDADO" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Ingredientes</Label>
              <Input value={form.ingredients} onChange={(e) => setForm({ ...form, ingredients: e.target.value })} placeholder="Pollo · Bacon · Queso · Lechuga · Tomate" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Info. nutricional (opcional)</Label>
              <Input value={form.nutrition} onChange={(e) => setForm({ ...form, nutrition: e.target.value })} placeholder="580 kcal · 32g proteína" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Imagen</Label>
              <ImageUploadField value={form.imageUrl} onChange={(v) => setForm({ ...form, imageUrl: v })} aspect="aspect-square" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Día de la semana</Label>
              <Select value={form.dayOfWeek} onValueChange={(v) => setForm({ ...form, dayOfWeek: v })}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue placeholder="Todos los días" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Todos los días</SelectItem>
                  {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Fecha específica</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Orden</Label>
              <Input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
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
