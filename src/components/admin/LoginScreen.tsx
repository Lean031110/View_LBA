"use client"

import { useState } from "react"
import { LogIn, Loader2, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { APP_NAME, APP_TAGLINE, APP_LOGO } from "@/lib/brand"

export default function LoginScreen({ onLogin }: { onLogin: (user: { id: string; email: string; name: string; role: string }) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Error de autenticación")
      onLogin(data.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "radial-gradient(1100px 500px at 75% -10%, #1d1d28 0%, #0c0c10 60%)" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          { }
          <img src={APP_LOGO} alt={`${APP_NAME} — ${APP_TAGLINE}`} className="h-12 w-auto mb-5" draggable={false} />
          <h1 className="text-2xl font-bold text-white">Panel de Administración</h1>
          <p className="text-white/45 text-sm mt-1">{APP_NAME} · {APP_TAGLINE}</p>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-white/70">Correo electrónico</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@restaurante.com"
              className="bg-white/[0.04] border-white/10"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-white/70">Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="bg-white/[0.04] border-white/10"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
              <Lock size={14} /> {error}
            </div>
          )}

          <Button type="submit" disabled={busy} className="w-full bg-amber-500 hover:bg-amber-400 text-black font-bold h-10">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} className="mr-1" />}
            {busy ? "Verificando…" : "Entrar"}
          </Button>

          <div className="text-center pt-1">
            <p className="text-[11px] text-white/30 leading-relaxed">
              Demo: admin@restaurante.com / admin123
              <br />
              Operador: operador@restaurante.com / operador123
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}
