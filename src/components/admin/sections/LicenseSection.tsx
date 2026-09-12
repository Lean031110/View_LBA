"use client"

import { useCallback, useEffect, useState } from "react"
import {
  BadgeCheck, ShieldCheck, Copy, Check, Loader2, AlertTriangle, Clock, Calendar, RefreshCw,
  Phone, Lock, History, XCircle, Send, KeyRound, MessageCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { getJSON } from "../api"
import type { FeatureKey } from "@/lib/licensing/types"
import { FEATURE_LABELS, FUTURE_FEATURE_LABELS } from "@/lib/licensing/features"

/**
 * Sección Licencia (v2 — flujo copiar/pegar).
 *
 * El cliente SOLO ve:
 *   1. Estado actual (humano: PRUEBA ACTIVA / LICENCIA ACTIVA / …)
 *   2. "Copiar código de solicitud" (el código se genera automáticamente con
 *      la identidad del equipo OCULTA dentro — nada de Installation ID/Disk
 *      ID a mano)
 *   3. Campo "Token de licencia" + "ACTIVAR LICENCIA"
 *   4. Info de la licencia activa: cliente, inicio, vencimiento, días restantes
 *
 * SIN ZIP, sin license.json, sin JSON, sin Installation ID, sin Disk ID,
 * sin hashes, sin criptografía visible.
 */

interface LicenseApiResponse {
  product: string
  status: "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"
  plan: "trial" | "monthly" | "annual" | "custom" | null
  daysLeft: number
  clockTampered: boolean
  reasons: string[]
  trial: { active: boolean; daysLeft: number; startedAt: string | null; endsAt: string | null } | null
  license: {
    licenseId: string
    customerName: string
    plan: "monthly" | "annual" | "custom"
    durationDays: number
    issuedAt: number
    startsAt: number
    expiresAt: number
    daysLeft: number
  } | null
  history: {
    licenseId: string
    customerName: string
    plan: string
    durationDays: number
    startsAt: number
    expiresAt: number
    activatedAt: number
    current: boolean
  }[]
  contact: string
  features: Record<string, boolean>
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  trial: { label: "PRUEBA ACTIVA", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  active: { label: "LICENCIA ACTIVA", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  grace: { label: "LICENCIA EN GRACIA", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  expired: { label: "LICENCIA VENCIDA", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  invalid: { label: "LICENCIA NO VÁLIDA", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  mismatch: { label: "LICENCIA NO CORRESPONDE A ESTE EQUIPO", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  unlicensed: { label: "SIN LICENCIA", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
}

const PLAN_LABEL: Record<string, string> = {
  trial: "Prueba (7 días)",
  monthly: "Mensual · USD 10",
  annual: "Anual · USD 100",
  custom: "Personalizada",
}

function fmtDay(ms: number | string | null | undefined): string {
  if (ms == null) return "—"
  const d = new Date(ms)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${dd}/${mm}/${d.getUTCFullYear()}`
}

export default function LicenseSection(props: Record<string, unknown>) {
  const user = props.user as { name: string; role: string } | undefined
  const [data, setData] = useState<LicenseApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Solicitud (paso 1: copiar código)
  const [customerName, setCustomerName] = useState("")
  const [generating, setGenerating] = useState(false)
  const [requestCode, setRequestCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Activación (paso 2: pegar token)
  const [token, setToken] = useState("")
  const [activating, setActivating] = useState(false)
  const [activateResult, setActivateResult] = useState<{ ok: boolean; message?: string; reason?: string } | null>(null)

  const { toast } = useToast()

  const load = useCallback(async () => {
    try {
      setError(null)
      const d = await getJSON<LicenseApiResponse>("/api/license")
      setData(d)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /** Paso 1: generar y COPIAR el código de solicitud. */
  const doCopyRequestCode = async () => {
    const name = customerName.trim()
    if (name.length < 2) {
      toast({ title: "Escribe el nombre de tu negocio", description: "El proveedor lo necesita para identificar tu licencia.", variant: "destructive" })
      return
    }
    setGenerating(true)
    setRequestCode(null)
    setCopied(false)
    try {
      const res = await fetch("/api/license/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName: name }),
      })
      const json = (await res.json().catch(() => ({}))) as { requestCode?: string; error?: string }
      if (res.ok && json.requestCode) {
        setRequestCode(json.requestCode)
        const ok = await copyToClipboard(json.requestCode)
        setCopied(ok)
        toast({
          title: ok ? "✓ Código copiado" : "Código generado",
          description: ok
            ? "Envíalo por WhatsApp al proveedor para recibir tu token de licencia."
            : "Cópialo del recuadro y envíalo por WhatsApp al proveedor.",
        })
      } else {
        toast({ title: "No se pudo generar el código", description: json.error ?? "Inténtalo de nuevo.", variant: "destructive" })
      }
    } catch (e) {
      toast({ title: "Error de conexión", description: (e as Error).message, variant: "destructive" })
    } finally {
      setGenerating(false)
    }
  }

  /** Paso 2: ACTIVAR el token pegado. */
  const doActivate = async () => {
    const t = token.trim()
    if (t.length === 0) {
      toast({ title: "Pega el token de licencia", description: "Es el texto VLBA2-… que te envió el proveedor.", variant: "destructive" })
      return
    }
    setActivating(true)
    setActivateResult(null)
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; reason?: string; error?: string }
      if (res.ok && json.ok) {
        setActivateResult({ ok: true, message: json.message })
        toast({ title: "✓ Licencia activada", description: json.message })
        setToken("")
        await load()
      } else {
        const reason = json.reason ?? json.error ?? "El token fue rechazado"
        setActivateResult({ ok: false, reason })
        toast({ title: "✗ Licencia rechazada", description: reason, variant: "destructive" })
      }
    } catch (e) {
      const reason = (e as Error).message
      setActivateResult({ ok: false, reason })
      toast({ title: "Error de activación", description: reason, variant: "destructive" })
    } finally {
      setActivating(false)
    }
  }

  if (error) {
    return (
      <div className="p-6 max-w-5xl">
        <Card className="bg-white/[0.03] border-white/10">
          <CardContent className="py-10 text-center space-y-3">
            <AlertTriangle size={30} className="mx-auto text-amber-400" />
            <p className="text-white/60 text-sm">No se pudo cargar el estado de la licencia: {error}</p>
            <Button size="sm" variant="outline" onClick={load} className="gap-2 border-white/15 bg-white/[0.03]">
              <RefreshCw size={14} /> Reintentar
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-6 max-w-5xl flex justify-center py-16">
        <Loader2 size={26} className="animate-spin text-amber-400" />
      </div>
    )
  }

  const meta = STATUS_META[data.status] ?? STATUS_META.unlicensed
  const isAdmin = user?.role === "ADMIN"
  const active = data.status === "active" || data.status === "grace"
  const whatsappLink = `https://wa.me/53${data.contact}?text=${encodeURIComponent("Hola, solicito una licencia de ViewLBA.")}`

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Encabezado */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
          <ShieldCheck size={22} className="text-amber-400" /> Licencia
        </h1>
        <p className="text-white/45 text-sm mt-0.5">Activación de tu licencia ViewLBA — copia, pega y listo</p>
      </div>

      {/* Aviso de manipulación de reloj */}
      {data.clockTampered && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-3">
          <Clock size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-red-300 font-semibold">Se detectó un retroceso del reloj del sistema</p>
            <p className="text-white/50 text-xs mt-0.5">La vigencia quedó congelada al último instante válido. Ajusta la fecha/hora del equipo y contacta al proveedor si el problema persiste.</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---------- Estado ---------- */}
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <BadgeCheck size={16} className="text-amber-400" /> Estado
              <Badge variant="outline" className={`ml-auto border ${meta.cls}`}>{meta.label}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {active && data.license ? (
              <>
                <Row label="Cliente" value={data.license.customerName} />
                <Row label="Plan" value={PLAN_LABEL[data.license.plan] ?? `${data.license.durationDays} días`} />
                <Row label="Licencia" value={data.license.licenseId} mono />
                <Row label="Inicio" value={fmtDay(data.license.startsAt)} icon={<Calendar size={13} />} />
                <Row label="Vence el" value={fmtDay(data.license.expiresAt)} icon={<Calendar size={13} />} />
                <Row label="Restan" value={`${data.license.daysLeft} días`} highlight />
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-400"
                    style={{
                      width: `${Math.min(100, Math.max(4, (data.license.daysLeft / Math.max(30, data.license.durationDays)) * 100))}%`,
                    }}
                  />
                </div>
              </>
            ) : data.status === "trial" ? (
              <>
                <Row label="Cliente" value="—" />
                <Row label="Plan" value={PLAN_LABEL.trial} />
                <Row label="Iniciada" value={fmtDay(data.trial?.startedAt)} icon={<Calendar size={13} />} />
                <Row label="Termina" value={fmtDay(data.trial?.endsAt)} icon={<Calendar size={13} />} />
                <Row label="Restan" value={`${data.trial?.daysLeft ?? data.daysLeft} días`} highlight />
                <p className="text-xs text-white/40 leading-relaxed">
                  Durante la prueba la pantalla TV muestra marca de agua y las funciones premium del panel están bloqueadas. Configuración básica, contenido, transmisión y health funcionan sin límites.
                </p>
              </>
            ) : (
              <>
                <Row label="Cliente" value={data.license?.customerName ?? "—"} />
                <Row label="Plan" value={data.license ? (PLAN_LABEL[data.license.plan] ?? `${data.license.durationDays} días`) : "—"} />
                {data.license && <Row label="Vence el" value={fmtDay(data.license.expiresAt)} icon={<Calendar size={13} />} />}
                {data.reasons.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1">
                    {data.reasons.map((r, i) => (
                      <p key={i} className="text-xs text-white/60 flex items-start gap-1.5"><XCircle size={12} className="mt-0.5 text-red-400/70 shrink-0" /> {r}</p>
                    ))}
                  </div>
                )}
                {data.status === "unlicensed" && (
                  <p className="text-xs text-white/50 leading-relaxed">
                    <span className="text-white/70 font-semibold">Período de prueba finalizado.</span> Para continuar, solicita y activa tu licencia con los pasos de abajo.
                  </p>
                )}
              </>
            )}
            <div className="pt-1 flex items-center gap-2 text-xs text-white/40">
              <Phone size={12} /> Soporte y licencias (WhatsApp): <span className="text-amber-300 font-semibold">{data.contact}</span>
            </div>
          </CardContent>
        </Card>

        {/* ---------- Paso 1: solicitar (copiar código) ---------- */}
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <Send size={16} className="text-amber-400" /> 1 · Solicitar licencia
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-white/45 leading-relaxed">
              Escribe el nombre de tu negocio y pulsa el botón: el código queda <span className="text-white/70">copiado</span> automáticamente. Envíalo por WhatsApp al proveedor ({data.contact}) y espera tu token.
            </p>
            <div className="flex gap-2">
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Nombre del negocio (ej. Lo D'Leo)"
                maxLength={100}
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-amber-500/40"
                aria-label="Nombre del negocio"
              />
              <Button onClick={doCopyRequestCode} disabled={generating} className="gap-2 bg-amber-500 hover:bg-amber-400 text-black font-bold shrink-0">
                {generating ? <Loader2 size={15} className="animate-spin" /> : copied ? <Check size={15} /> : <Copy size={15} />}
                {generating ? "GENERANDO…" : copied ? "CÓDIGO COPIADO" : "COPIAR CÓDIGO"}
              </Button>
            </div>
            {requestCode && (
              <div className="space-y-2">
                <textarea
                  readOnly
                  value={requestCode}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full h-24 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5 text-[11px] font-mono text-amber-200/80 resize-none focus:outline-none custom-scrollbar"
                  aria-label="Código de solicitud"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      const ok = await copyToClipboard(requestCode)
                      setCopied(ok)
                    }}
                    className="inline-flex items-center gap-1.5 text-[11px] text-white/40 hover:text-amber-300 transition-colors"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    {copied ? "Copiado" : "Copiar de nuevo"}
                  </button>
                  <a
                    href={whatsappLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400/80 hover:text-emerald-300 transition-colors"
                  >
                    <MessageCircle size={12} /> Abrir WhatsApp
                  </a>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- Paso 2: activar (pegar token) ---------- */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <KeyRound size={16} className="text-amber-400" /> 2 · Activar licencia
            {!isAdmin && <Lock size={12} className="ml-auto text-white/30" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdmin ? (
            <>
              <p className="text-xs text-white/45 leading-relaxed">
                Pega aquí el <span className="font-mono text-white/60">Token de licencia</span> (empieza por <span className="font-mono text-white/60">VLBA2-</span>) que te envió el proveedor por WhatsApp y pulsa <span className="text-white/70">ACTIVAR LICENCIA</span>.
              </p>
              <textarea
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="VLBA2-XXXX-XXXX-XXXX-…"
                spellCheck={false}
                className="w-full h-24 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-[11px] font-mono text-white/80 resize-none focus:outline-none focus:border-amber-500/40 custom-scrollbar"
                aria-label="Token de licencia"
              />
              <Button onClick={doActivate} disabled={activating} className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold">
                {activating ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />}
                {activating ? "ACTIVANDO…" : "ACTIVAR LICENCIA"}
              </Button>
              {activateResult?.ok && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-1.5">
                  {[
                    "Token verificado y válido",
                    "Vinculación con este equipo correcta",
                    "Licencia guardada en el servidor",
                  ].map((t) => (
                    <p key={t} className="text-sm text-emerald-300 flex items-center gap-2"><Check size={15} /> {t}</p>
                  ))}
                  {activateResult.message && <p className="text-xs text-white/50 pt-1">{activateResult.message}</p>}
                  <p className="text-xs text-white/40 pt-1">La marca de agua de la pantalla TV desaparece y las funciones premium quedan habilitadas en segundos (refresco realtime).</p>
                </div>
              )}
              {activateResult && !activateResult.ok && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 space-y-1.5">
                  <p className="text-sm text-red-300 font-semibold flex items-center gap-2"><XCircle size={15} /> No se pudo activar la licencia</p>
                  <p className="text-xs text-white/60">{activateResult.reason}</p>
                  <p className="text-xs text-white/40 pt-1">No se modificó nada: la licencia actual (si existe) sigue vigente. Contacta {data.contact} (WhatsApp) si el problema persiste.</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-white/40 py-2 flex items-center gap-2"><Lock size={13} /> Solo un administrador puede activar licencias.</p>
          )}
        </CardContent>
      </Card>

      {/* ---------- Características ---------- */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <ShieldCheck size={16} className="text-amber-400" /> Características según tu plan
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(FEATURE_LABELS) as FeatureKey[])
              .filter((k) => k !== "display.watermark")
              .map((key) => {
                const on = data.features?.[key] === true
                return (
                  <div key={key} className="flex items-center gap-2.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                    {on ? <Check size={14} className="text-emerald-400 shrink-0" /> : <Lock size={14} className="text-white/30 shrink-0" />}
                    <span className={`text-sm ${on ? "text-white/80" : "text-white/40"}`}>{FEATURE_LABELS[key]}</span>
                    {!on && <span className="ml-auto text-[10px] text-amber-300/60 font-semibold">PREMIUM</span>}
                  </div>
                )
              })}
            {/* §18 misión 3.1: features FUTURAS presentes en el token (si el
                emisor las incluyó) — mostradas sin gating todavía */}
            {(Object.keys(FUTURE_FEATURE_LABELS) as string[])
              .filter((k) => data.features?.[k] === true)
              .map((key) => (
                <div key={key} className="flex items-center gap-2.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                  <Check size={14} className="text-emerald-400/70 shrink-0" />
                  <span className="text-sm text-white/60">{FUTURE_FEATURE_LABELS[key]}</span>
                </div>
              ))}
          </div>
          <p className="text-xs text-white/35 mt-3">
            {active
              ? "Plan comercial: todas las funciones desbloqueadas."
              : "Las funciones premium se activan al activar una licencia Mensual o Anual."}
          </p>
        </CardContent>
      </Card>

      {/* ---------- Historial ---------- */}
      {data.history.length > 0 && (
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <History size={16} className="text-amber-400" /> Historial de licencias
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto custom-scrollbar">
              <table className="w-full text-sm">
                <tbody>
                  {data.history.map((h, i) => (
                    <tr key={`${h.licenseId}-${i}`} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-2 px-2 font-mono text-xs text-amber-300/80 w-32">{h.licenseId}</td>
                      <td className="py-2 px-2 text-white/70 text-xs">{h.customerName}</td>
                      <td className="py-2 px-2 text-xs w-28">
                        <span className={h.plan === "annual" ? "text-emerald-400" : "text-white/50"}>
                          {h.plan === "annual" ? "Anual" : h.plan === "monthly" ? "Mensual" : `${h.durationDays} días`}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-white/50 text-xs w-44 whitespace-nowrap">
                        {fmtDay(h.startsAt)} → {fmtDay(h.expiresAt)}
                      </td>
                      <td className="py-2 px-2 w-20">
                        {h.current ? (
                          <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">ACTUAL</Badge>
                        ) : (
                          <span className="text-[10px] text-white/25">reemplazada</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Row({ label, value, icon, highlight, mono }: { label: string; value: string; icon?: React.ReactNode; highlight?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/40 flex items-center gap-1.5 shrink-0">{icon ?? <span className="w-[13px]" />} {label}</span>
      <span className={`text-right truncate ${highlight ? "text-amber-300 font-bold text-base" : "text-white/85 text-sm"} ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}
