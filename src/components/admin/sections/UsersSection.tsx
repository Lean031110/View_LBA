"use client"

import { useEffect, useState } from "react"
import { Users, Plus, Pencil, Trash2, Loader2, ShieldCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON } from "../api"

interface UserRow { id: string; email: string; name: string; role: string; active: boolean; lastLoginAt: string | null }
interface FormState { email: string; name: string; role: string; password: string; active: boolean }
const emptyForm: FormState = { email: "", name: "", role: "OPERATOR", password: "", active: true }

const ROLE_INFO: Record<string, string> = {
  ADMIN: "Control total, incl. usuarios y pantallas",
  OPERATOR: "Contenido, transmisión y configuración",
  VIEWER: "Solo lectura (dashboard y registros)",
}

export default function UsersSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<UserRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const load = () => getJSON<{ items: UserRow[] }>("/api/admin/users").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const submit = async () => {
    if (!form.email.trim() || !form.name.trim() || (!editing && !form.password)) {
      return toast({ title: "Email, nombre y contraseña requeridos", variant: "destructive" })
    }
    setBusy(true)
    try {
      if (editing) {
        const body: Record<string, unknown> = { email: form.email, name: form.name, role: form.role, active: form.active }
        if (form.password) body.password = form.password
        await putJSON(`/api/admin/users/${editing}`, body)
      } else {
        await postJSON("/api/admin/users", form)
      }
      toast({ title: "Usuario guardado" })
      setOpen(false)
      load()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally { setBusy(false) }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><Users size={22} className="text-amber-400" /> Usuarios</h1>
          <p className="text-white/45 text-sm mt-0.5">Roles: administrador, operador y consulta</p>
        </div>
        <Button onClick={() => { setForm(emptyForm); setEditing(null); setOpen(true) }} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
          <Plus size={16} /> Nuevo usuario
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : (
        <div className="space-y-3">
          {items.map((u) => (
            <Card key={u.id} className={`bg-white/[0.03] border-white/10 ${!u.active ? "opacity-50" : ""}`}>
              <CardContent className="py-4 flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-500/12 border border-amber-500/25 flex items-center justify-center text-sm font-bold text-amber-300 shrink-0">
                  {u.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white">{u.name}</span>
                    <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${u.role === "ADMIN" ? "text-amber-300 bg-amber-400/10 border border-amber-400/25" : u.role === "OPERATOR" ? "text-emerald-300 bg-emerald-400/10 border border-emerald-400/25" : "text-white/50 bg-white/5 border border-white/15"}`}>
                      {u.role}
                    </span>
                  </div>
                  <div className="text-xs text-white/45 mt-0.5">{u.email}</div>
                  <div className="text-[11px] text-white/30 mt-0.5">
                    {u.lastLoginAt ? `Último acceso: ${new Date(u.lastLoginAt).toLocaleString("es")}` : "Nunca ha iniciado sesión"}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={u.active} onCheckedChange={async (v) => { await putJSON(`/api/admin/users/${u.id}`, { active: v }).catch(() => {}); load() }} />
                  <Button size="icon" variant="ghost" onClick={() => { setForm({ email: u.email, name: u.name, role: u.role, password: "", active: u.active }); setEditing(u.id); setOpen(true) }} className="h-8 w-8 text-white/60 hover:text-white"><Pencil size={14} /></Button>
                  <Button size="icon" variant="ghost" onClick={async () => { if (confirm(`¿Eliminar a ${u.name}?`)) { await deleteJSON(`/api/admin/users/${u.id}`).catch((e) => toast({ title: "Error", description: (e as Error).message, variant: "destructive" })); load() } }} className="h-8 w-8 text-white/60 hover:text-red-400"><Trash2 size={14} /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-md">
          <DialogHeader><DialogTitle className="text-white">{editing ? "Editar usuario" : "Nuevo usuario"}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-white/80">Nombre *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Email *</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Rol</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger className="bg-white/[0.04] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_INFO).map(([r, desc]) => (
                    <SelectItem key={r} value={r}>
                      <span className="flex flex-col"><span className="font-semibold">{r}</span><span className="text-[11px] text-white/40">{desc}</span></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">{editing ? "Nueva contraseña (opcional)" : "Contraseña *"}</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5">
              <div>
                <Label className="text-white/85">Activo</Label>
                <p className="text-[11px] text-white/40">Puede iniciar sesión</p>
              </div>
              <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
            </div>
            <div className="flex gap-2 items-center rounded-lg bg-white/[0.02] border border-white/10 px-3 py-2.5">
              <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
              <p className="text-[11px] text-white/45">Las contraseñas se almacenan con hash scrypt + salt. Nunca se envían al navegador.</p>
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
