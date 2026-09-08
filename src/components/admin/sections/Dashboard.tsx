"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MonitorPlay, Radio, Tag, ChefHat, Activity, ExternalLink, Eye, RefreshCw, AlertTriangle, DatabaseBackup, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ScreenStatus, ContentBundle } from "@/lib/types"
import { getJSON, postJSON } from "../api"
import { useToast } from "@/hooks/use-toast"
import type { StreamServerStatus } from "../AdminApp"

const stateLabels: Record<string, { label: string; cls: string }> = {
  live: { label: "EN DIRECTO", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  connecting: { label: "CONECTANDO", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  fallback: { label: "FALLBACK", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  offline: { label: "DESCONECTADA", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  disabled: { label: "INACTIVA", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
}

export default function Dashboard({
  screensStatus,
  realtimeConnected,
  streamServer,
  user,
}: {
  user: { name: string; role: string }
  screensStatus: ScreenStatus[]
  realtimeConnected: boolean
  sendCommand: (t: string, p?: Record<string, unknown>, s?: string) => void
  section: string
  setSection: (s: string) => void
  streamServer?: StreamServerStatus | null
}) {
  const [content, setContent] = useState<ContentBundle | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    getJSON<ContentBundle>("/api/content")
      .then(setContent)
      .catch(() => {})
  }, [])

  // FASE 16: backup manual verificado (solo ADMIN)
  const runBackup = async () => {
    setBackingUp(true)
    try {
      const r = await postJSON<{ ok: boolean; file: string; sizeBytes: number; integrity: string; tables: Record<string, number> }>("/api/admin/backup", {})
      toast({
        title: "Copia de seguridad creada",
        description: `${(r.sizeBytes / 1024).toFixed(0)} KB · integridad ${r.integrity} · ${Object.keys(r.tables).length} tablas. Guardada en el servidor (BACKUP_DIR).`,
      })
    } catch (e) {
      toast({ title: "Error en el backup", description: (e as Error).message, variant: "destructive" })
    } finally {
      setBackingUp(false)
    }
  }

  const streamUrl = content?.settings.streamUrl
  const isLocal = (content?.settings.streamSource ?? "local") === "local"
  const serverLive = streamServer?.source === "local" ? streamServer.live : null
  const serverViewers = streamServer?.viewers ?? 0
  const streamState = isLocal
    ? serverLive
      ? "live"
      : "waiting"
    : screensStatus.find((s) => s.streamState === "live")
      ? "live"
      : streamUrl
        ? "waiting"
        : "none"

  const online = screensStatus.filter((s) => s.online).length
  const live = screensStatus.filter((s) => s.streamState === "live").length

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-white/45 text-sm mt-0.5">Estado general del sistema de señalización</p>
        </div>
        <Link href="/?view=tv" target="_blank">
          <Button variant="outline" size="sm" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
            <ExternalLink size={14} /> Abrir pantalla TV
          </Button>
        </Link>
      </div>

      {/* Tarjetas resumen */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <span className="text-white/45 text-xs font-semibold uppercase tracking-wide">Transmisión</span>
              <Radio size={16} className={streamState === "live" ? "text-red-400" : "text-white/30"} />
            </div>
            <div className="mt-2.5">
              {streamState === "live" ? (
                <Badge className="bg-red-500/15 text-red-400 border-red-500/30 border">● EN DIRECTO</Badge>
              ) : isLocal ? (
                <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 border">ESPERANDO OBS</Badge>
              ) : streamUrl ? (
                <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 border">ESPERANDO STREAM</Badge>
              ) : (
                <Badge variant="outline" className="text-white/50 border-white/20">SIN CONFIGURAR</Badge>
              )}
            </div>
            <p className="text-xs text-white/35 mt-2.5">
              {isLocal
                ? streamState === "live"
                  ? `Servidor RTMP local · ${serverViewers} espectador(es)`
                  : "Inicia la transmisión desde OBS Studio"
                : live > 0
                  ? `${live} pantalla(s) reproduciendo`
                  : streamUrl
                    ? "Las pantallas reintentan cada 30s"
                    : "Configura la URL en Transmisión"}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <span className="text-white/45 text-xs font-semibold uppercase tracking-wide">Pantallas</span>
              <MonitorPlay size={16} className="text-white/30" />
            </div>
            <div className="text-3xl font-bold text-white mt-2">
              {online} <span className="text-base font-medium text-white/35">/ {screensStatus.length || (content?.screens.length ?? 0)} online</span>
            </div>
            <p className="text-xs text-white/35 mt-1">Dispositivos conectados al realtime</p>
          </CardContent>
        </Card>

        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <span className="text-white/45 text-xs font-semibold uppercase tracking-wide">Promociones</span>
              <Tag size={16} className="text-white/30" />
            </div>
            <div className="text-3xl font-bold text-white mt-2">{content?.promotions.length ?? "—"}</div>
            <p className="text-xs text-white/35 mt-1">Activas en el carrusel</p>
          </CardContent>
        </Card>

        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <span className="text-white/45 text-xs font-semibold uppercase tracking-wide">Plato del día</span>
              <ChefHat size={16} className="text-white/30" />
            </div>
            <div className="text-base font-bold text-white mt-2.5 truncate">{content?.dishes[0]?.name ?? "Sin configurar"}</div>
            <p className="text-xs text-white/35 mt-1">{content?.dishes[0]?.price ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Pantallas conectadas */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <MonitorPlay size={16} className="text-amber-400" /> Pantallas en tiempo real
            <span className={`ml-auto flex items-center gap-1.5 text-[11px] font-medium ${realtimeConnected ? "text-emerald-400" : "text-white/40"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${realtimeConnected ? "bg-emerald-400" : "bg-white/30"}`} />
              {realtimeConnected ? "Realtime conectado" : "Realtime sin conexión"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {screensStatus.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle size={28} className="text-white/20" />
              <p className="text-sm text-white/40">
                Ninguna pantalla conectada. Abre la pantalla TV en un navegador o televisor y aparecerá aquí.
              </p>
              <Link href="/?view=tv" target="_blank">
                <Button size="sm" variant="outline" className="mt-1 border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
                  <Eye size={14} /> Abrir pantalla de prueba
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {screensStatus.map((s) => {
                const st = stateLabels[s.streamState] ?? stateLabels.offline
                const up = s.online
                return (
                  <div key={s.screenCode} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center gap-3">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${up ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-amber-300">{s.screenCode}</span>
                        <span className={`text-[10px] font-bold ${up ? "text-emerald-400" : "text-zinc-500"}`}>{up ? "ONLINE" : "OFFLINE"}</span>
                      </div>
                      <div className="text-xs text-white/40 mt-0.5 truncate">
                        {s.resolution} · {upTimeFmt(s.lastSeen - s.connectedAt)}
                      </div>
                    </div>
                    <Badge variant="outline" className={st.cls}>{st.label}</Badge>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actividad reciente */}
      <RecentActivity backup={{ running: backingUp }} onBackup={user?.role === "ADMIN" ? runBackup : null} />
    </div>
  )
}

function upTimeFmt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins} min conectada`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m conectada`
}

function RecentActivity({ backup, onBackup }: { backup: { running: boolean } | null; onBackup: (() => void) | null }) {
  const [logs, setLogs] = useState<{ id: string; userName: string | null; action: string; section: string | null; createdAt: string }[]>([])
  useEffect(() => {
    getJSON<{ items: typeof logs }>("/api/admin/logs?limit=8")
      .then((d) => setLogs(d.items))
      .catch(() => {})
  }, [])
  return (
    <Card className="bg-white/[0.03] border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-white">
          <Activity size={16} className="text-amber-400" /> Actividad reciente
          {onBackup && (
            <Button
              size="sm"
              variant="outline"
              onClick={onBackup}
              disabled={Boolean(backup?.running)}
              className="ml-auto h-7 text-xs gap-1.5 border-white/15 bg-white/[0.03] hover:bg-white/10"
            >
              {backup?.running ? <Loader2 size={12} className="animate-spin" /> : <DatabaseBackup size={12} />} Copia de seguridad
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <p className="text-sm text-white/35 py-4">Sin actividad registrada todavía.</p>
        ) : (
          <div className="space-y-2">
            {logs.map((l) => (
              <div key={l.id} className="flex items-center gap-3 text-sm">
                <span className="text-white/30 text-xs w-20 shrink-0">
                  {new Date(l.createdAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="font-mono text-[11px] text-amber-300/80 w-24 shrink-0">{l.action}</span>
                <span className="text-white/50 text-xs truncate">
                  {l.userName ? `${l.userName} · ` : ""}
                  {l.section}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
