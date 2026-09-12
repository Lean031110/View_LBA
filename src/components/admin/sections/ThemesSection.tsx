"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Palette, Loader2, Upload, Check, Trash2, AlertTriangle, RefreshCw, Lock, Info,
  ShieldCheck, Package, RotateCcw, Eye,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { getJSON } from "../api"
import type { ThemeSpec } from "@/lib/themes/types"
import type { LicensePanelInfo } from "../AdminApp"

/**
 * §6/§7 — GESTOR DE TEMAS DE PANTALLA (v3.1).
 *
 * Funciones: temas instalados · tema activo · importar .vtheme · eliminar ·
 * aplicar · vista previa · información · restaurar tema predeterminado.
 * El tema predeterminado NO se puede eliminar (§7).
 *
 * Disponible SOLO con licencia completa (themes.custom): durante el trial
 * la sección se ve pero muestra el candado «Los temas de pantalla están
 * disponibles con una licencia completa» (§17: visualizar sí, importar no).
 */

interface ThemeItem {
  id: string
  name: string
  author: string
  version: string
  description: string
  builtin: boolean
  installedAt: string | null
  active: boolean
  assets: { name: string; bytes: number; width: number | null; height: number | null }[]
  spec: ThemeSpec
  broken: boolean
}

interface ThemesApiResponse {
  themes: ThemeItem[]
}

const STYLE_LABEL: Record<string, string> = {
  "classic": "Clásico",
  "digital": "Digital",
  "neon": "Neón",
  "fade": "Fundido",
  "slide": "Deslizamiento",
  "zoom": "Zoom",
  "gradient": "Degradado",
  "grid": "Retícula",
  "glow": "Brillos",
  "none": "Ninguno",
  "soft": "Suave",
  "display": "Titular",
  "serif": "Serif",
  "sans": "Sans",
  "mono": "Mono",
}

export default function ThemesSection({ license }: { license: LicensePanelInfo | null }) {
  const { toast } = useToast()
  const [themes, setThemes] = useState<ThemeItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const themesAllowed = license !== null && license.features["themes.custom"] === true

  const load = useCallback(() => {
    getJSON<ThemesApiResponse>("/api/admin/themes")
      .then((d) => {
        setThemes(d.themes ?? [])
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ---------- Importar (multipart .vtheme) ----------
  const onImportFile = async (file: File) => {
    setImporting(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch("/api/admin/themes", { method: "POST", body: form })
      const data = (await res.json().catch(() => ({}))) as { error?: string; theme?: { themeId: string; name: string; assets: number } }
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      toast({
        title: "Tema importado",
        description: `«${data.theme?.name}» validado e instalado (${data.theme?.assets} assets). Actívalo para verlo en la TV.`,
      })
      load()
    } catch (e) {
      toast({ title: "No se pudo importar el tema", description: (e as Error).message, variant: "destructive" })
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  // ---------- Activar ----------
  const activate = async (t: ThemeItem) => {
    setWorking(t.id)
    try {
      const res = await fetch(`/api/admin/themes/${encodeURIComponent(t.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate" }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      toast({ title: "Tema aplicado", description: `«${t.name}» está activo. Las pantallas TV conectadas lo reciben al instante.` })
      load()
    } catch (e) {
      toast({ title: "No se pudo aplicar el tema", description: (e as Error).message, variant: "destructive" })
    } finally {
      setWorking(null)
    }
  }

  // ---------- Eliminar ----------
  const remove = async (t: ThemeItem) => {
    if (!window.confirm(`¿Eliminar el tema «${t.name}»?${t.active ? "\n\nEs el tema ACTIVO: la pantalla volverá al tema predeterminado." : ""}`)) {
      return
    }
    setWorking(t.id)
    try {
      const res = await fetch(`/api/admin/themes/${encodeURIComponent(t.id)}`, { method: "DELETE" })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      toast({ title: "Tema eliminado", description: t.active ? "La pantalla volvió al tema predeterminado." : "El tema se eliminó del almacenamiento." })
      load()
    } catch (e) {
      toast({ title: "No se pudo eliminar el tema", description: (e as Error).message, variant: "destructive" })
    } finally {
      setWorking(null)
    }
  }

  // ---------- Render ----------
  if (error) {
    return (
      <div className="p-6 max-w-4xl">
        <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-10 text-center space-y-3">
          <AlertTriangle size={28} className="text-red-400 mx-auto" />
          <h2 className="text-lg font-bold text-white">No se pudo cargar el gestor de temas</h2>
          <p className="text-sm text-white/50">{error}</p>
          <Button onClick={load} variant="outline" className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2">
            <RefreshCw size={15} /> Reintentar
          </Button>
        </div>
      </div>
    )
  }

  if (!themes) {
    return <div className="p-6 flex justify-center py-16"><Loader2 size={30} className="animate-spin text-amber-400" /></div>
  }

  const activeTheme = themes.find((t) => t.active) ?? themes.find((t) => t.id === "default")!

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Palette size={22} className="text-amber-400" /> Temas de Pantalla
          </h1>
          <p className="text-white/45 text-sm mt-0.5">
            Importa, aplica y administra los temas visuales de la pantalla TV · Paquete oficial: <span className="text-white/70">.vtheme</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="border-white/15 bg-white/[0.03] hover:bg-white/10 gap-2"
            onClick={() => activate(activeTheme.id === "default" ? activeTheme : themes.find((t) => t.id === "default")!)}
            disabled={!themesAllowed || working !== null}
            title={activeTheme.id === "default" ? "El tema predeterminado ya está activo" : "Volver al tema integrado de fábrica"}
          >
            <RotateCcw size={15} /> Restaurar predeterminado
          </Button>
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={!themesAllowed || importing}
            className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2"
          >
            {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} Importar tema (.vtheme)
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".vtheme"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportFile(f)
            }}
          />
        </div>
      </div>

      {/* §17: trial → candado (visualizar sí, importar/aplicar no) */}
      {!themesAllowed && (
        <Card className="bg-amber-500/[0.06] border-amber-500/25">
          <CardContent className="flex items-center gap-4 py-4">
            <div className="w-11 h-11 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
              <Lock size={20} className="text-amber-400" />
            </div>
            <div className="flex-1">
              <p className="text-white font-semibold text-sm">Los temas de pantalla están disponibles con una licencia completa.</p>
              <p className="text-white/45 text-xs mt-1">
                Plan Mensual USD 10 · Anual USD 100 · Contacto: <span className="text-amber-300 font-semibold">52973387</span> — los temas instalados se conservan al activarla.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Estado activo */}
      <Card className="bg-emerald-500/[0.05] border-emerald-500/20">
        <CardContent className="flex items-center gap-4 py-4">
          <ShieldCheck size={20} className="text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white/90">
              Tema activo: <span className="font-bold text-white">{activeTheme.name}</span>{" "}
              <span className="text-white/40 font-mono text-xs">v{activeTheme.version}</span>
              {activeTheme.builtin && <span className="text-white/35 text-xs"> · integrado</span>}
            </p>
            <p className="text-xs text-white/40 mt-0.5">
              Los cambios se propagan a las pantallas TV conectadas en tiempo real (no hace falta recargar el servidor).
            </p>
          </div>
          <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 border">ACTIVO</Badge>
        </CardContent>
      </Card>

      {/* Grid de temas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {themes.map((t) => (
          <Card
            key={t.id}
            data-theme-card={t.id}
            className={`bg-white/[0.03] border transition-colors ${t.active ? "border-emerald-500/40" : "border-white/10 hover:border-white/25"} ${t.broken ? "border-red-500/40" : ""}`}
          >
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base text-white flex items-center gap-2 min-w-0">
                  <span className="truncate">{t.name}</span>
                </CardTitle>
                {t.active ? (
                  <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">Activo</Badge>
                ) : t.builtin ? (
                  <Badge className="bg-white/8 text-white/60 border border-white/15 shrink-0">Integrado</Badge>
                ) : (
                  <Badge className="bg-sky-500/12 text-sky-300 border border-sky-500/25 shrink-0">Importado</Badge>
                )}
              </div>
              <p className="text-[11px] text-white/40 font-mono">
                {t.id} · v{t.version} {t.author ? `· ${t.author}` : ""}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Vista previa (mini-maqueta con la paleta del tema) */}
              <ThemePreview spec={t.spec} />
              {t.description && <p className="text-xs text-white/50 leading-snug line-clamp-2">{t.description}</p>}

              {t.broken && (
                <p className="text-xs text-red-400 flex items-center gap-1.5">
                  <AlertTriangle size={13} /> Paquete dañado (theme.json inválido). Elimínalo y vuelve a importarlo.
                </p>
              )}

              {/* Info técnica resumida */}
              <div className="flex items-center gap-2 text-[11px] text-white/35">
                <Info size={12} />
                <span>
                  Reloj {STYLE_LABEL[t.spec.clock.style] ?? t.spec.clock.style} · Carrusel {STYLE_LABEL[t.spec.carousel.transition] ?? t.spec.carousel.transition} · Fondo{" "}
                  {STYLE_LABEL[t.spec.background.effect] ?? t.spec.background.effect}
                  {t.assets.length > 0 ? ` · ${t.assets.length} assets` : ""}
                </span>
              </div>

              <div className="flex gap-2 pt-1">
                {t.active ? (
                  <Button disabled className="flex-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 gap-2" variant="outline">
                    <Check size={15} /> Aplicado
                  </Button>
                ) : (
                  <Button
                    onClick={() => activate(t)}
                    disabled={!themesAllowed || working !== null || t.broken}
                    className="flex-1 bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2"
                  >
                    {working === t.id ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Aplicar
                  </Button>
                )}
                {!t.builtin && (
                  <Button
                    onClick={() => remove(t)}
                    disabled={!themesAllowed || working !== null}
                    variant="outline"
                    className="border-red-500/25 text-red-400 hover:bg-red-500/10 hover:text-red-300 gap-2"
                    title="Eliminar tema (el predeterminado no se puede eliminar)"
                  >
                    {working === t.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Ayuda: formato y seguridad */}
      <Card className="bg-white/[0.02] border-white/8">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-white flex items-center gap-2">
            <Package size={14} className="text-white/40" /> ¿Qué es un paquete .vtheme?
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-white/45 space-y-1.5 leading-relaxed">
          <p>
            Un archivo <span className="text-white/70 font-mono">.vtheme</span> es un paquete <b>declarativo y seguro</b>: manifiesto + configuración visual +
            imágenes. <b>No puede contener código</b> (scripts, ejecutables y HTML se rechazan automáticamente) — ViewLBA renderiza el tema con su propio motor.
          </p>
          <p>
            Los temas oficiales de ViewLBA (Classic y Neon) vienen integrados; archivos .vtheme adicionales se importan desde aquí. Límites: 50 MB por paquete,
            120 MB descomprimido, 200 entradas — los paquetes maliciosos se rechazan sin crash.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/** Mini-maqueta de vista previa con la paleta y el estilo del tema. */
function ThemePreview({ spec }: { spec: ThemeSpec }) {
  return (
    <div
      className="relative rounded-lg overflow-hidden border border-white/10 h-20"
      style={{ background: spec.palette.bg }}
      aria-label="Vista previa del tema"
    >
      {/* Capa decorativa del efecto de fondo (equivalente visual del motor) */}
      {spec.background.effect === "gradient" && (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 90% 70% at 50% 0%, ${spec.palette.primary}22, transparent 70%), radial-gradient(ellipse 70% 60% at 50% 100%, ${spec.palette.accent}18, transparent 65%)`,
          }}
        />
      )}
      {spec.background.effect === "grid" && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(${spec.palette.primary}14 1px, transparent 1px), linear-gradient(90deg, ${spec.palette.primary}14 1px, transparent 1px)`,
            backgroundSize: "14px 14px",
          }}
        />
      )}
      {spec.background.effect === "glow" && (
        <>
          <div className="absolute -top-6 -left-4 w-24 h-24 rounded-full" style={{ background: spec.palette.primary, filter: "blur(28px)", opacity: 0.5 }} />
          <div className="absolute -bottom-8 -right-4 w-24 h-24 rounded-full" style={{ background: spec.palette.accent, filter: "blur(30px)", opacity: 0.45 }} />
        </>
      )}

      {/* Maqueta: banda de reloj + tarjeta de promo + ticker */}
      <div className="relative h-full flex flex-col p-2 gap-1.5">
        <div className="flex items-center justify-between">
          <span
            className="font-bold leading-none"
            style={{
              color: spec.clock.style === "neon" ? spec.palette.primary : "#ffffff",
              textShadow: spec.clock.style === "neon" ? `0 0 6px ${spec.palette.primary}66` : undefined,
              fontFamily: spec.clock.style === "digital" || spec.clock.style === "neon" ? "monospace" : undefined,
              fontSize: 13,
            }}
          >
            8:45 PM
          </span>
          <span style={{ color: "#ffffff70", fontSize: 8 }}>LA TERRAZA</span>
        </div>
        <div
          className="flex-1 flex items-center px-2 min-h-0"
          style={{
            background: `color-mix(in srgb, ${spec.palette.surface} 92%, transparent)`,
            borderRadius: Math.min(spec.cards.radius, 12) * 0.5,
            boxShadow:
              spec.cards.shadow === "glow"
                ? `0 0 10px ${spec.palette.primary}55`
                : spec.cards.shadow === "soft"
                  ? "0 4px 10px rgba(0,0,0,0.4)"
                  : "none",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div className="flex flex-col gap-1 min-w-0">
            <span className="font-bold text-white truncate" style={{ fontSize: 10 }}>
              PROMO 2×1
            </span>
            <span className="truncate" style={{ color: spec.palette.primary, fontSize: 9 }}>
              $12.50 · Oferta
            </span>
          </div>
        </div>
        <div
          className="h-2.5 rounded-sm flex items-center px-1.5"
          style={{
            background: spec.ticker.style === "neon" ? `color-mix(in srgb, ${spec.palette.bg} 85%, #000)` : "#ffffff",
            boxShadow: spec.ticker.style === "neon" ? `inset 0 1px 0 0 ${spec.palette.primary}` : undefined,
          }}
        >
          <span style={{ color: spec.ticker.style === "neon" ? "#ffffffcc" : "#27272a", fontSize: 7 }}>
            {spec.ticker.style === "neon" ? "MENSAJE EN MOVIMIENTO ·" : "MENSAJE EN MOVIMIENTO ·"}
          </span>
        </div>
      </div>
    </div>
  )
}
