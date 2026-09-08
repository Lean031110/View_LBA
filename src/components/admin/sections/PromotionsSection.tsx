"use client"

import { useEffect, useState } from "react"
import { Tag, Plus, Pencil, Trash2, Loader2, GripVertical } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"
import ImageUploadField from "../ImageUploadField"
import type { PromotionDTO } from "@/lib/types"

interface FormState {
  title: string
  description: string
  price: string
  oldPrice: string
  discount: string
  badge: string
  imageUrl: string | null
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  duration: number
  order: number
  active: boolean
}

const emptyForm: FormState = {
  title: "", description: "", price: "", oldPrice: "", discount: "", badge: "", imageUrl: null,
  startDate: "", endDate: "", startTime: "", endTime: "", duration: 10, order: 0, active: true,
}

export default function PromotionsSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<PromotionDTO[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const load = () => {
    getJSON<{ items: PromotionDTO[] }>("/api/admin/promotions")
      .then((d) => setItems(d.items))
      .catch((e: Error) => toast({ title: "Error cargando promociones", description: e.message, variant: "destructive" }))
  }

  useEffect(() => {
    load()
     
  }, [])

  const openNew = () => {
    setForm({ ...emptyForm, order: (items?.length ?? 0) + 1 })
    setEditing(null)
    setOpen(true)
  }

  const openEdit = (p: PromotionDTO) => {
    setForm({
      title: p.title, description: p.description ?? "", price: p.price ?? "", oldPrice: p.oldPrice ?? "",
      discount: p.discount ?? "", badge: p.badge ?? "", imageUrl: p.imageUrl,
      startDate: p.startDate?.slice(0, 10) ?? "", endDate: p.endDate?.slice(0, 10) ?? "",
      startTime: p.startTime ?? "", endTime: p.endTime ?? "",
      duration: p.duration, order: p.order, active: p.active,
    })
    setEditing(p.id)
    setOpen(true)
  }

  const submit = async () => {
    if (!form.title.trim()) {
      toast({ title: "Título requerido", variant: "destructive" })
      return
    }
    setBusy(true)
    try {
      const body = { ...form, startDate: form.startDate || null, endDate: form.endDate || null }
      if (editing) await putJSON(`/api/admin/promotions/${editing}`, body)
      else await postJSON("/api/admin/promotions", body)
      toast({ title: editing ? "Promoción actualizada" : "Promoción creada", description: "Visible en las pantallas en segundos." })
      setOpen(false)
      load()
    } catch (e) {
      toast({ title: "Error al guardar", description: (e as Error).message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: PromotionDTO) => {
    if (!confirm(`¿Eliminar la promoción "${p.title}"?`)) return
    await deleteJSON(`/api/admin/promotions/${p.id}`).catch(() => {})
    load()
  }

  const toggleActive = async (p: PromotionDTO) => {
    await putJSON(`/api/admin/promotions/${p.id}`, { active: !p.active }).catch(() => {})
    load()
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Tag size={22} className="text-amber-400" /> Promociones</h1>
          <p className="text-white/45 text-sm mt-0.5">Carrusel de ofertas — se sincronizan en las pantallas al instante</p>
        </div>
        <Button onClick={openNew} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          <Plus size={16} /> Nueva promoción
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : items.length === 0 ? (
        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="py-12 text-center text-white/40 text-sm">
            Aún no hay promociones. Crea la primera con el botón de arriba.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((p) => (
            <Card key={p.id} className={`bg-white/[0.03] border-white/10 ${!p.active ? "opacity-50" : ""}`}>
              <CardContent className="py-4 flex items-center gap-4">
                <GripVertical size={16} className="text-white/15 shrink-0" />
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" className="w-20 h-14 rounded-lg object-cover border border-white/10 shrink-0" />
                ) : (
                  <div className="w-20 h-14 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                    <Tag size={16} className="text-white/20" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white truncate">{p.title}</span>
                    {p.badge && <span className="text-[10px] font-bold text-amber-300 bg-amber-400/10 border border-amber-400/25 rounded px-1.5 py-0.5">{p.badge}</span>}
                    {p.discount && <span className="text-[10px] font-bold text-red-400 bg-red-400/10 border border-red-400/25 rounded px-1.5 py-0.5">{p.discount}</span>}
                  </div>
                  <div className="text-xs text-white/45 mt-0.5 truncate">
                    {p.price && <span className="text-amber-300 font-semibold mr-2">{p.price}</span>}
                    {p.description}
                  </div>
                  <div className="text-[11px] text-white/30 mt-0.5">
                    Orden {p.order} · {p.duration}s por slide
                    {p.startTime || p.endTime ? ` · Ventana ${p.startTime || "—"} a ${p.endTime || "—"}` : ""}
                    {p.startDate || p.endDate ? ` · ${p.startDate?.slice(0, 10) ?? "…"} → ${p.endDate?.slice(0, 10) ?? "…"}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={p.active} onCheckedChange={() => toggleActive(p)} />
                  <Button size="icon" variant="ghost" onClick={() => openEdit(p)} className="h-8 w-8 text-white/60 hover:text-white">
                    <Pencil size={14} />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(p)} className="h-8 w-8 text-white/60 hover:text-red-400">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog de edición */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="text-white">{editing ? "Editar promoción" : "Nueva promoción"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Título *</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="BACONBURGER" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Descripción</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Doble carne a la parrilla, bacon crocante…" className="bg-white/[0.04] border-white/10 resize-none" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Precio</Label>
              <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="$299" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Precio anterior</Label>
              <Input value={form.oldPrice} onChange={(e) => setForm({ ...form, oldPrice: e.target.value })} placeholder="$399" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Descuento</Label>
              <Input value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} placeholder="20% OFF" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Etiqueta</Label>
              <Input value={form.badge} onChange={(e) => setForm({ ...form, badge: e.target.value })} placeholder="PROMO DE HOY" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-white/80">Imagen</Label>
              <ImageUploadField value={form.imageUrl} onChange={(v) => setForm({ ...form, imageUrl: v })} />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Fecha inicio</Label>
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Fecha fin</Label>
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Hora inicio</Label>
              <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Hora fin</Label>
              <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Duración en carrusel (segundos)</Label>
              <Input type="number" min={4} max={60} value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Orden de aparición</Label>
              <Input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between sm:col-span-2 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
              <div>
                <Label className="text-white/85">Activa</Label>
                <p className="text-xs text-white/40">Visible en las pantallas</p>
              </div>
              <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/15 bg-transparent hover:bg-white/5">Cancelar</Button>
            <Button onClick={submit} disabled={busy} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
              {busy && <Loader2 size={15} className="animate-spin" />} {editing ? "Guardar cambios" : "Crear promoción"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
