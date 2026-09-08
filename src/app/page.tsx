"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import Launcher from "@/components/Launcher"
import TvDisplay from "@/components/display/TvDisplay"
import AdminApp from "@/components/admin/AdminApp"

function AppInner() {
  const params = useSearchParams()
  const view = params.get("view") ?? "home"

  if (view === "tv") return <TvDisplay />
  if (view === "admin") return <AdminApp />
  return <Launcher />
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#0b0b0f]">
          <div className="w-12 h-12 rounded-full border-4 border-white/10 border-t-amber-400 animate-spin" />
        </div>
      }
    >
      <AppInner />
    </Suspense>
  )
}
