"use client"

import { useEffect, useState } from "react"
import { Share2, Plus, Pencil, Trash2, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"
import { SocialIcon, SOCIAL_NETWORKS } from "../../display/SocialIcons"
import type { SocialLinkDTO } from "@/lib/types"

interface FormState { network: string; username: string; url: string; color: string; order: number; active: boolean }
const emptyForm: FormState = { network: "INSTAGRAM", username: "", url: "", color: "", order: 1, active: true }

export default function SocialsSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<SocialLinkDTO[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const load = () => getJSON<{ items: SocialLinkDTO[] }>("/api/admin/socials").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const submit = async () => {
    setBusy(true)
    try {
      if (editing) await putJSON(`/api/admin/socials/${editing}`, form)
      else await postJSON("/api/admin/socials", form)
      toast({ title: "Red guardada", description: "La franja social se actualiza al instante." })
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
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Share2 size={22} className="text-amber-400" /> Redes Sociales</h1>
          <p className="text-white/45 text-sm mt-0.5">Franja inferior compacta — Facebook · Instagram · WhatsApp con destellos</p>
        </div>
        <Button onClick={() => { setForm({ ...emptyForm, order: (items?.length ?? 0) + 1 }); setEditing(null); setOpen(true) }} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          <Plus size={16} /> Nueva red
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <Card key={s.id} className={`bg-white/[0.03] border-white/10 ${!s.active ? "opacity-50" : ""}`}>
              <CardContent className="py-4 flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                  <SocialIcon network={s.network} size={22} color={s.color} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-white text-sm tracking-wide">{s.network}</div>
                  <div className="text-xs text-white/45 truncate">{s.username || s.url || "—"}</div>
                  <div className="text-[11px] text-white/30">orden {s.order}</div>
                </div>
                <div className="flex flex-col gap-1 items-end">
                  <Switch checked={s.active} onCheckedChange={async (v) => { await putJSON(`/api/admin/socials/${s.id}`, { active: v }).catch(() => {}); load() }} />
                  <Button size="icon" variant="ghost" onClick={() => { setForm({ network: s.network, username: s.username ?? "", url: s.url ?? "", color: s.color ?? "", order: s.order, active: s.active }); setEditing(s.id); setOpen(true) }} className="h-7 w-7 text-white/60 hover:text-white"><Pencil size={13} /></Button>
                  <Button size="icon" variant="ghost" onClick={async () => { if (confirm(`¿Eliminar ${s.network}?`)) { await deleteJSON(`/api/admin/socials/${s.id}`).catch(() => {}); load() } }} className="h-7 w-7 text-white/60 hover:text-red-400"><Trash2 size={13} /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-lg">
          <DialogHeader><DialogTitle className="text-white">{editing ? "Editar red" : "Nueva red social"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Red</Label>
              <Select value={form.network} onValueChange={(v) => setForm({ ...form, network: v })}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOCIAL_NETWORKS.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Usuario (se muestra en pantalla)</Label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="@tucuenta" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">URL de destino (opcional)</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Color personalizado</Label>
              <input type="color" value={form.color || "#ffffff"} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-full h-9 rounded-lg bg-transparent border border-white/15 cursor-pointer" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Orden</Label>
              <Input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5 col-span-2">
              <Label className="text-white/85">Visible en pantalla</Label>
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
