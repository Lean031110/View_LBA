"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  BadgeCheck, ShieldCheck, Copy, Check, UploadCloud, Loader2, HardDrive, MapPin, Fingerprint,
  AlertTriangle, Clock, Calendar, RefreshCw, Phone, Lock, History, XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { getJSON } from "../api"
import type { FeatureKey } from "@/lib/licensing/types"
import { FEATURE_LABELS } from "@/lib/licensing/features"

/**
 * Sección Licencia (secciones 15/32/34 del requisito).
 * Estado + identificación del equipo + importación ZIP + features + historial.
 * Importar solo ADMIN; ver estado: ADMIN/OPERATOR.
 */

interface LicenseApiResponse {
  product: string
  status: "trial" | "active" | "expired" | "invalid" | "mismatch" | "grace" | "unlicensed"
  plan: "trial" | "monthly" | "annual" | null
  daysLeft: number
  clockTampered: boolean
  reasons: string[]
  trial: { active: boolean; daysLeft: number; startedAt: string | null; endsAt: string | null } | null
  license: {
    licenseId: string
    customerName: string
    plan: "monthly" | "annual"
    issuedAt: string
    startsAt: string
    expiresAt: string
    deviceId: string
    diskId: string
    installPath: string
    features: Record<string, boolean>
  } | null
  validation: {
    status: string
    reasons: string[]
    detail?: {
      expectedInstallationId?: string
      foundInstallationId?: string
      expectedDiskId?: string
      foundDiskId?: string
      installPathWarning?: string
    }
  } | null
  identity: {
    installationId: string
    diskId: string
    diskLabel: string
    installPath: string
    bindingStrength: { fingerprint: string; disk: string }
  }
  history: {
    licenseId: string
    customerName: string
    plan: string
    startsAt: string
    expiresAt: string
    importedAt: string
    current: boolean
  }[]
  contact: string
  features: Record<string, boolean>
}

const STATUS_META: Record<string, { label: string; cls: string; icon: string }> = {
  trial: { label: "PRUEBA", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", icon: "🕐" },
  active: { label: "ACTIVA", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: "✓" },
  grace: { label: "GRACIA", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", icon: "⏳" },
  expired: { label: "VENCIDA", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30", icon: "⚠" },
  invalid: { label: "NO VÁLIDA", cls: "bg-red-500/15 text-red-400 border-red-500/30", icon: "✗" },
  mismatch: { label: "OTRO EQUIPO", cls: "bg-red-500/15 text-red-400 border-red-500/30", icon: "✗" },
  unlicensed: { label: "SIN LICENCIA", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", icon: "—" },
}

const PLAN_LABEL: Record<string, string> = { trial: "Prueba (7 días)", monthly: "Mensual · USD 10", annual: "Anual · USD 100" }

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "numeric" })
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {}
      }}
      className="inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-amber-300 transition-colors"
      title="Copiar"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {label ? (copied ? "Copiado" : label) : null}
    </button>
  )
}

export default function LicenseSection(props: Record<string, unknown>) {
  const user = props.user as { name: string; role: string } | undefined
  const [data, setData] = useState<LicenseApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ ok: boolean; message?: string; reasons?: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
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

  const doImport = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      toast({ title: "Selecciona el archivo ZIP", description: "Elige el ViewLBA-License-….zip que te envió el proveedor.", variant: "destructive" })
      return
    }
    setImporting(true)
    setImportResult(null)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch("/api/license/import", { method: "POST", body: form })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; reasons?: string[] }
      if (res.ok && json.ok) {
        setImportResult({ ok: true, message: json.message })
        toast({ title: "✓ Licencia importada", description: json.message })
        await load()
        if (fileRef.current) fileRef.current.value = ""
      } else {
        const reasons = json.reasons ?? (json.error ? [json.error] : ["Importación rechazada"])
        setImportResult({ ok: false, reasons })
        toast({ title: "✗ Licencia rechazada", description: reasons[0], variant: "destructive" })
      }
    } catch (e) {
      setImportResult({ ok: false, reasons: [(e as Error).message] })
      toast({ title: "Error de importación", description: (e as Error).message, variant: "destructive" })
    } finally {
      setImporting(false)
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

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Encabezado */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
          <ShieldCheck size={22} className="text-amber-400" /> Licencia
        </h1>
        <p className="text-white/45 text-sm mt-0.5">Estado de la licencia de ViewLBA y vinculación con este equipo</p>
      </div>

      {/* Aviso de manipulación de reloj */}
      {data.clockTampered && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-3">
          <Clock size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-red-300 font-semibold">Se detectó un retroceso del reloj del sistema</p>
            <p className="text-white/50 text-xs mt-0.5">El período de evaluación quedó congelado al último instante válido. Ajusta la fecha/hora del equipo y contacta al proveedor si el problema persiste.</p>
          </div>
        </div>
      )}

      {/* MISMATCH (sección 19): mensaje específico */}
      {data.status === "mismatch" && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-4 space-y-2">
          <p className="text-red-300 font-semibold flex items-center gap-2"><AlertTriangle size={16} /> La licencia está vinculada a otra instalación/disco</p>
          <div className="text-xs text-white/60 space-y-1 font-mono">
            <p>Installation ID actual: <span className="text-amber-300">{data.validation?.detail?.expectedInstallationId ?? data.identity.installationId}</span></p>
            <p>Disk ID actual: <span className="text-amber-300">{data.validation?.detail?.expectedDiskId ?? data.identity.diskId}</span></p>
            <p>Licencia emitida para: <span className="text-white/40">{data.validation?.detail?.foundInstallationId} · {data.validation?.detail?.foundDiskId}</span></p>
          </div>
          <p className="text-xs text-white/50">Contacte <span className="text-amber-300 font-semibold">{data.contact}</span> para emitir una nueva licencia.</p>
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
                <Row label="Plan" value={PLAN_LABEL[data.license.plan] ?? data.license.plan} />
                <Row label="Licencia" value={data.license.licenseId} mono />
                <Row label="Inicio" value={fmtDate(data.license.startsAt)} icon={<Calendar size={13} />} />
                <Row label="Vencimiento" value={fmtDate(data.license.expiresAt)} icon={<Calendar size={13} />} />
                <Row label="Días restantes" value={String(data.daysLeft)} highlight />
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-400"
                    style={{
                      width: `${Math.min(100, Math.max(4, (data.daysLeft / (data.license.plan === "annual" ? 365 : 30)) * 100))}%`,
                    }}
                  />
                </div>
              </>
            ) : data.status === "trial" ? (
              <>
                <Row label="Cliente" value="—" />
                <Row label="Plan" value={PLAN_LABEL.trial} />
                <Row label="Iniciada" value={fmtDate(data.trial?.startedAt)} icon={<Calendar size={13} />} />
                <Row label="Termina" value={fmtDate(data.trial?.endsAt)} icon={<Calendar size={13} />} />
                <Row label="Días restantes" value={String(data.trial?.daysLeft ?? data.daysLeft)} highlight />
                <p className="text-xs text-white/40 leading-relaxed">
                  Durante la prueba la pantalla TV muestra marca de agua y las funciones premium del panel están bloqueadas. Configuración básica, contenido, transmisión y health funcionan sin límites.
                </p>
              </>
            ) : (
              <>
                <Row label="Cliente" value={data.license?.customerName ?? "—"} />
                <Row label="Plan" value={data.license ? (PLAN_LABEL[data.license.plan] ?? data.license.plan) : "—"} />
                <Row label="Vencimiento" value={fmtDate(data.license?.expiresAt)} icon={<Calendar size={13} />} />
                {data.reasons.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1">
                    {data.reasons.map((r, i) => (
                      <p key={i} className="text-xs text-white/60 flex items-start gap-1.5"><XCircle size={12} className="mt-0.5 text-red-400/70 shrink-0" /> {r}</p>
                    ))}
                  </div>
                )}
                {data.status === "unlicensed" && (
                  <p className="text-xs text-white/50 leading-relaxed">
                    <span className="text-white/70 font-semibold">Período de prueba finalizado.</span> Para continuar, activa tu licencia. La pantalla TV sigue mostrando contenido básico y aquí puedes importar la licencia.
                  </p>
                )}
              </>
            )}
            {data.validation?.detail?.installPathWarning && (
              <p className="text-[11px] text-white/35 flex items-start gap-1.5"><MapPin size={12} className="mt-0.5 shrink-0" /> {data.validation.detail.installPathWarning}</p>
            )}
            <div className="pt-1 flex items-center gap-2 text-xs text-white/40">
              <Phone size={12} /> Soporte y licencias: <span className="text-amber-300 font-semibold">{data.contact}</span>
            </div>
          </CardContent>
        </Card>

        {/* ---------- Equipo / Vinculación ---------- */}
        <Card className="bg-white/[0.03] border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <Fingerprint size={16} className="text-amber-400" /> Equipo vinculado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-amber-300/80 font-semibold">Identificador de instalación</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base text-white tracking-wider">{data.identity.installationId}</span>
                <CopyButton text={data.identity.installationId} label="Copiar" />
              </div>
              <p className="text-[11px] uppercase tracking-wide text-amber-300/80 font-semibold pt-1">Disco</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm text-white/90 tracking-wide">{data.identity.diskId}</span>
                <span className="text-xs text-white/40">· {data.identity.diskLabel}</span>
                <CopyButton text={data.identity.diskId} label="Copiar" />
              </div>
              <p className="text-xs text-white/35 flex items-center gap-1.5 pt-1">
                <HardDrive size={12} /> Binding: <span className="font-mono text-white/25 tracking-[0.3em]">••••••••</span>
                <span className="text-white/25">({data.identity.bindingStrength.fingerprint} · {data.identity.bindingStrength.disk})</span>
              </p>
              <p className="text-xs text-white/35 flex items-center gap-1.5">
                <MapPin size={12} /> Ruta: <span className="font-mono text-white/50">{data.identity.installPath}</span>
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-white/40 font-semibold">Bloque para solicitar tu licencia</p>
              <textarea
                readOnly
                value={`ViewLBA — Solicitud de licencia\nNombre del cliente: (tu nombre)\nInstallation ID: ${data.identity.installationId}\nDisk ID: ${data.identity.diskId}\nRuta: ${data.identity.installPath}`}
                className="w-full h-24 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-[11px] font-mono text-white/60 resize-none focus:outline-none"
              />
              <CopyButton
                text={`ViewLBA — Solicitud de licencia\nNombre del cliente: (tu nombre)\nInstallation ID: ${data.identity.installationId}\nDisk ID: ${data.identity.diskId}\nRuta: ${data.identity.installPath}`}
                label="Copiar bloque completo"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------- Importación ---------- */}
      <Card className="bg-white/[0.03] border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <UploadCloud size={16} className="text-amber-400" /> Importar licencia
            {!isAdmin && <Lock size={12} className="ml-auto text-white/30" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdmin ? (
            <>
              <p className="text-xs text-white/45 leading-relaxed">
                Selecciona el archivo <span className="font-mono text-white/60">ViewLBA-License-….zip</span> entregado por el proveedor. Se valida la firma digital, el plan, las fechas y la vinculación a este equipo y disco — solo se guarda si todo es correcto.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip"
                  className="text-sm text-white/60 file:mr-3 file:rounded-lg file:border-0 file:bg-amber-500/15 file:text-amber-300 file:px-3 file:py-1.5 file:text-xs file:font-semibold hover:file:bg-amber-500/25 file:cursor-pointer file:transition-colors"
                />
                <Button onClick={doImport} disabled={importing} className="gap-2 bg-amber-500 hover:bg-amber-400 text-black font-bold">
                  {importing ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
                  IMPORTAR LICENCIA
                </Button>
              </div>
              {importResult?.ok && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-1.5">
                  {[
                    "Licencia creada y firmada",
                    "Firma digital verificada",
                    "Binding de equipo y disco correcto",
                    "Licencia guardada en el servidor",
                  ].map((t) => (
                    <p key={t} className="text-sm text-emerald-300 flex items-center gap-2"><Check size={15} /> {t}</p>
                  ))}
                  {importResult.message && <p className="text-xs text-white/50 pt-1">{importResult.message}</p>}
                  <p className="text-xs text-white/40 pt-1">La marca de agua de la pantalla TV desaparece y las funciones premium quedan habilitadas en segundos (refresco realtime).</p>
                </div>
              )}
              {importResult && !importResult.ok && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 space-y-1.5">
                  <p className="text-sm text-red-300 font-semibold flex items-center gap-2"><XCircle size={15} /> Licencia rechazada</p>
                  {importResult.reasons?.map((r, i) => (
                    <p key={i} className="text-xs text-white/60 flex items-start gap-1.5">— {r}</p>
                  ))}
                  <p className="text-xs text-white/40 pt-1">No se modificó nada: la licencia actual (si existe) sigue vigente. Contacta {data.contact} si el problema persiste.</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-white/40 py-2 flex items-center gap-2"><Lock size={13} /> Solo un administrador puede importar licencias.</p>
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
          </div>
          <p className="text-xs text-white/35 mt-3">
            {active
              ? "Plan comercial: todas las funciones desbloqueadas."
              : "Las funciones premium se activan al importar una licencia Mensual o Anual."}
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
                      <td className="py-2 px-2 text-xs w-24">
                        <span className={h.plan === "annual" ? "text-emerald-400" : "text-white/50"}>{h.plan === "annual" ? "Anual" : "Mensual"}</span>
                      </td>
                      <td className="py-2 px-2 text-white/50 text-xs w-44 whitespace-nowrap">
                        {h.startsAt.slice(0, 10)} → {h.expiresAt.slice(0, 10)}
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
