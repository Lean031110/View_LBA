"use client"

import { useEffect, useState } from "react"
import { ScrollText, Loader2, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { getJSON } from "../api"

interface LogRow { id: string; userName: string | null; action: string; section: string | null; details: string | null; createdAt: string }

const ACTION_COLORS: Record<string, string> = {
  LOGIN: "text-emerald-300 bg-emerald-400/10",
  LOGIN_FAILED: "text-red-400 bg-red-400/10",
  LOGOUT: "text-white/50 bg-white/5",
  CREATE: "text-amber-300 bg-amber-400/10",
  UPDATE: "text-sky-300 bg-sky-400/10",
  DELETE: "text-red-400 bg-red-400/10",
  UPLOAD: "text-purple-300 bg-purple-400/10",
  STREAM_TEST: "text-orange-300 bg-orange-400/10",
  COMMAND: "text-pink-300 bg-pink-400/10",
}

export default function LogsSection(props: Record<string, unknown>) {
  const [items, setItems] = useState<LogRow[] | null>(null)
  const [filter, setFilter] = useState("")

  const load = () => getJSON<{ items: LogRow[] }>("/api/admin/logs?limit=200").then((d) => setItems(d.items)).catch(() => setItems([]))
  useEffect(() => {
    load()
     
  }, [])

  const filtered = items?.filter((l) =>
    !filter || l.action?.toLowerCase().includes(filter.toLowerCase()) || l.section?.toLowerCase().includes(filter.toLowerCase()) || l.userName?.toLowerCase().includes(filter.toLowerCase())
  ) ?? []

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2.5"><ScrollText size={22} className="text-amber-400" /> Registros</h1>
        <p className="text-white/45 text-sm mt-0.5">Auditoría de accesos y cambios del sistema</p>
      </div>

      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            Actividad
            <span className="ml-auto relative w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar por acción, usuario…" className="bg-white/[0.04] border-white/10 h-8 text-sm pl-9" />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {items === null ? (
            <div className="flex justify-center py-12"><Loader2 size={26} className="animate-spin text-amber-400" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-white/40 py-8 text-center">Sin registros que coincidan.</p>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto custom-scrollbar -mx-2">
              <table className="w-full text-sm">
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-2 px-2 text-white/35 text-xs whitespace-nowrap w-36 align-top">
                        {new Date(l.createdAt).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="py-2 px-2 w-28 align-top">
                        <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 font-mono ${ACTION_COLORS[l.action] ?? "text-white/50 bg-white/5"}`}>{l.action}</span>
                      </td>
                      <td className="py-2 px-2 text-white/60 text-xs w-28 align-top">{l.section ?? "—"}</td>
                      <td className="py-2 px-2 text-white/70 text-xs align-top">
                        {l.userName ? <span className="text-white/85 font-medium">{l.userName}</span> : <span className="text-white/35">sistema</span>}
                        {l.details && <span className="text-white/35"> · {l.details.slice(0, 90)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
