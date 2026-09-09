"use client"

import { useEffect, useState } from "react"
import { MonitorPlay, Plus, Trash2, Loader2, RotateCw, Pencil, MapPin, Terminal, KeyRound } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { getJSON, postJSON, putJSON, deleteJSON, patchJSON } from "../api"
import type { ScreenStatus } from "@/lib/types"

interface ScreenRow {
  id: string; code: string; name: string; location: string | null; notes: string | null; active: boolean
  online?: boolean; live?: ScreenStatus | null
}

interface FormState { code: string; name: string; location: string; notes: string; active: boolean; pairCode: string }
const emptyForm: FormState = { code: "", name: "", location: "", notes: "", active: true, pairCode: "" }

export default function ScreensSection({
  user,
  screensStatus,
  realtimeConnected,
  sendCommand,
}: {
  user: { name: string; role: string }
  screensStatus: ScreenStatus[]
  realtimeConnected: boolean
  sendCommand: (t: string, p?: Record<string, unknown>, s?: string) => void
  section: string
  setSection: (s: string) => void
}) {
  const [items, setItems] = useState<ScreenRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  // FASE 4: VIEWER solo lectura (el backend también lo exige: PUT/POST/PATCH = OPERATOR+)
  const canEdit = user.role === "ADMIN" || user.role === "OPERATOR"

  const load = () => getJSON<{ items: ScreenRow[] }>("/api/admin/screens").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const liveByCode = new Map(screensStatus.map((s) => [s.screenCode, s]))

  const submit = async () => {
    // FASE 32: con código de vinculación, el código de pantalla es opcional (auto TV-###)
    if (!form.name.trim()) return toast({ title: "Nombre requerido", variant: "destructive" })
    if (!editing && !form.code.trim() && !/^\d{6}$/.test(form.pairCode.trim())) {
      return toast({ title: "Indica el código de la pantalla (TV-004) o el código de 6 dígitos que muestra la TV", variant: "destructive" })
    }
    setBusy(true)
    try {
      if (editing) {
        await putJSON(`/api/admin/screens/${editing}`, form)
      } else {
        const res = await postJSON<{ paired?: boolean; note?: string; pairDelivered?: number }>("/api/admin/screens", {
          ...form,
          pairCode: /^\d{6}$/.test(form.pairCode.trim()) ? form.pairCode.trim() : undefined,
          code: form.code.trim() || undefined,
        })
        if (res?.paired) toast({ title: "Pantalla vinculada", description: "La TV recibió su token y quedó verificada." })
        else if (res?.note) toast({ title: "Pantalla creada", description: res.note })
        else toast({ title: "Pantalla guardada" })
      }
      setOpen(false)
      load()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    } finally { setBusy(false) }
  }

  /** FASE 32: (re)vincular una pantalla existente — la TV muestra un código
   *  de 6 dígitos y el token nuevo se le entrega directamente. */
  const pairScreen = async (sc: ScreenRow) => {
    if (user.role !== "ADMIN") return toast({ title: "Solo ADMIN puede vincular pantallas", variant: "destructive" })
    const code = (prompt(`Código de 6 dígitos que muestra la TV ${sc.code} (tecla S en el TV para reabrir el selector):`) ?? "").trim()
    if (!/^\d{6}$/.test(code)) return toast({ title: "Código inválido", description: "Deben ser exactamente 6 dígitos.", variant: "destructive" })
    try {
      await postJSON(`/api/admin/screens/${sc.id}/token`, { pairCode: code })
      toast({ title: "Vinculada", description: `${sc.code} recibió su token nuevo. El token anterior quedó invalidado.` })
    } catch (e) {
      toast({ title: "No se pudo vincular", description: (e as Error).message, variant: "destructive" })
    }
  }

  const reloadScreen = async (code?: string) => {
    try {
      await patchJSON("/api/admin/screens", { command: "reload", screenCode: code ?? undefined })
      toast({ title: "Comando enviado", description: code ? `${code} se recargará en segundos.` : "Todas las pantallas se recargarán." })
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" })
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><MonitorPlay size={22} className="text-amber-400" /> Pantallas</h1>
          <p className="text-white/45 text-sm mt-0.5">
            Multipantalla: TV-001, TV-002… · <span className={realtimeConnected ? "text-emerald-400" : "text-white/40"}>{realtimeConnected ? "realtime conectado" : "realtime sin conexión"}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {canEdit && (
            <>
              <Button onClick={() => reloadScreen()} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
                <RotateCw size={15} /> Reiniciar todas
              </Button>
              <Button onClick={() => { setForm(emptyForm); setEditing(null); setOpen(true) }} className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
                <Plus size={16} /> Nueva pantalla
              </Button>
            </>
          )}
        </div>
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((sc) => {
            const live = liveByCode.get(sc.code)
            const online = live?.online ?? false
            return (
              <Card key={sc.id} className={`bg-white/[0.03] border-white/10 ${!sc.active ? "opacity-50" : ""}`}>
                <CardContent className="pt-5 pb-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-amber-300">{sc.code}</span>
                        <Badge variant="outline" className={`text-[10px] font-bold ${online ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" : "text-zinc-500 border-zinc-500/30 bg-zinc-500/10"}`}>
                          {online ? "● ONLINE" : "OFFLINE"}
                        </Badge>
                      </div>
                      <div className="font-bold text-white mt-1">{sc.name}</div>
                      {sc.location && <div className="text-xs text-white/40 flex items-center gap-1 mt-0.5"><MapPin size={11} /> {sc.location}</div>}
                    </div>
                    {canEdit ? (
                      <Switch checked={sc.active} onCheckedChange={async (v) => { await putJSON(`/api/admin/screens/${sc.id}`, { active: v }).catch(() => {}); load() }} />
                    ) : (
                      <Badge variant="outline" className={`text-[10px] font-bold ${sc.active ? "text-emerald-400/70 border-emerald-500/20" : "text-zinc-500 border-zinc-500/30"}`}>
                        {sc.active ? "ACTIVA" : "INACTIVA"}
                      </Badge>
                    )}
                  </div>

                  {live && (
                    <div className="text-[11px] text-white/45 space-y-0.5 rounded-lg bg-white/[0.02] border border-white/8 px-3 py-2">
                      <div className="flex justify-between"><span>Resolución</span><span className="font-mono text-white/60">{live.resolution || "—"}</span></div>
                      <div className="flex justify-between"><span>Stream</span><span className="font-mono text-white/60">{live.streamState}</span></div>
                      {live.streamInfo?.uptime ? <div className="flex justify-between"><span>Uptime</span><span className="font-mono text-white/60">{Math.floor(live.streamInfo.uptime / 60)} min</span></div> : null}
                      {live.streamInfo?.resolution ? <div className="flex justify-between"><span>Video</span><span className="font-mono text-white/60">{live.streamInfo.resolution}</span></div> : null}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    {canEdit && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => reloadScreen(sc.code)} className="border-white/12 bg-white/[0.03] hover:bg-white/10 h-7 text-xs gap-1.5">
                          <RotateCw size={11} /> Reiniciar
                        </Button>
                        {user.role === "ADMIN" && (
                          <Button size="sm" variant="outline" onClick={() => pairScreen(sc)} className="border-amber-500/30 bg-amber-500/[0.08] hover:bg-amber-500/20 h-7 text-xs gap-1.5 text-amber-300">
                            <KeyRound size={11} /> Vincular
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" onClick={() => { setForm({ code: sc.code, name: sc.name, location: sc.location ?? "", notes: sc.notes ?? "", active: sc.active, pairCode: "" }); setEditing(sc.id); setOpen(true) }} className="h-7 w-7 text-white/60 hover:text-white"><Pencil size={13} /></Button>
                        <Button size="icon" variant="ghost" onClick={async () => { if (confirm(`¿Eliminar ${sc.code}?`)) { await deleteJSON(`/api/admin/screens/${sc.id}`).catch(() => {}); load() } }} className="h-7 w-7 text-white/60 hover:text-red-400"><Trash2 size={13} /></Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Instrucciones de vinculación */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-white/70 flex items-center gap-2"><Terminal size={14} className="text-white/40" /> Vincular un televisor</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-white/45 leading-relaxed space-y-1.5">
          <p>1. Abre el navegador del TV (o mini PC / Android TV) en la URL de la plataforma con <code className="text-amber-300/80 bg-white/5 px-1 rounded">?view=tv</code></p>
          <p>2. La primera vez, la TV muestra un <b className="text-amber-300/90">código de 6 dígitos</b>. Pulsa <b>Nueva pantalla</b>, introduce ese código y un nombre: la TV recibirá su token automáticamente y quedará <b>verificada</b> (nadie más podrá suplantarla).</p>
          <p>3. Para cambiar/reparar la identidad después: pulsa la tecla <kbd className="bg-white/8 px-1 rounded text-white/70">S</kbd> en la pantalla TV (aparecerá un código nuevo) y usa <b>Vincular</b> en la tarjeta de esa pantalla.</p>
          <p>4. La selección manual de la lista solo da identidad <i>no verificada</i> — adecuada para pantallas de prueba; las pantallas con token requieren vinculación por código.</p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141b] border-white/12 max-w-lg">
          <DialogHeader><DialogTitle className="text-white">{editing ? "Editar pantalla" : "Nueva pantalla"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            {!editing && (
              <div className="space-y-2 col-span-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3">
                <Label className="text-amber-300/90 flex items-center gap-1.5"><KeyRound size={12} /> Código de vinculación de la TV</Label>
                <Input value={form.pairCode} onChange={(e) => setForm({ ...form, pairCode: e.target.value.replace(/\D/g, "").slice(0, 6) })} placeholder="123456" className="bg-white/[0.04] border-white/10 font-mono tracking-widest" inputMode="numeric" />
                <p className="text-[11px] text-white/40 leading-snug">El código de 6 dígitos que muestra la TV en pantalla. Con él, el token se entrega automáticamente (identidad verificada). Si lo dejas vacío, crea una pantalla manual.</p>
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-white/80">Código {editing ? "*(inmutable)" : ""}</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder={form.pairCode ? "auto (TV-###)" : "TV-004"} disabled={Boolean(editing)} className="bg-white/[0.04] border-white/10 font-mono" />
            </div>
            <div className="space-y-2">
              <Label className="text-white/80">Nombre *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="TV Terraza" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Ubicación</Label>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Terraza norte" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="text-white/80">Notas</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Pantalla 75&quot; HDMI 2" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5 col-span-2">
              <Label className="text-white/85">Activa</Label>
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
