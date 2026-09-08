"use client"

import { useEffect, useRef, useState } from "react"
import { getJSON, putJSON } from "./api"
import { useToast } from "@/hooks/use-toast"

/** Hook compartido: carga y guarda la configuración global (Settings). */
export function useSettings() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    getJSON<{ settings: Record<string, unknown> }>("/api/admin/settings")
      .then((d) => setSettings(d.settings))
      .catch((e: Error) => toast({ title: "Error cargando configuración", description: e.message, variant: "destructive" }))
     
  }, [])

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true)
    try {
      const d = await putJSON<{ settings: Record<string, unknown> }>("/api/admin/settings", patch)
      setSettings(d.settings)
      toast({ title: "Cambios publicados", description: "Las pantallas se actualizan en segundos." })
      return true
    } catch (e) {
      toast({ title: "Error al guardar", description: (e as Error).message, variant: "destructive" })
      return false
    } finally {
      setSaving(false)
    }
  }

  return { settings, setSettings, saving, save }
}
