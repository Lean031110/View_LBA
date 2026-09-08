"use client"

import { motion } from "framer-motion"
import { MonitorPlay, MonitorSmartphone } from "lucide-react"

/** Selector de identidad: ¿qué pantalla física es este dispositivo? */
export default function ScreenPicker({
  screens,
  current,
  onSelect,
  onClose,
}: {
  screens: { code: string; name: string; location: string | null }[]
  current: string | null
  onSelect: (code: string | null) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(5,5,8,0.82)", backdropFilter: "blur(10px)" }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-2xl rounded-2xl border border-white/12 p-8"
        style={{ background: "#14141b" }}
      >
        <div className="flex items-center gap-3 mb-2">
          <MonitorPlay size={28} style={{ color: "var(--tv-primary)" }} />
          <h2 className="text-xl font-bold text-white">Identificar esta pantalla</h2>
        </div>
        <p className="text-white/55 text-sm mb-6 leading-relaxed">
          Selecciona qué pantalla física es este dispositivo. La asociación se guarda en el navegador y permite al
          panel de administración monitorearla y enviarle comandos remotos. (Podrás cambiarla más tarde pulsando la
          tecla <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/80">S</kbd>).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-80 overflow-y-auto custom-scrollbar pr-1">
          {screens.map((s) => (
            <button
              key={s.code}
              onClick={() => onSelect(s.code)}
              className={`text-left rounded-xl border p-4 transition-all hover:border-white/40 hover:bg-white/5 ${
                current === s.code ? "border-amber-400/70 bg-amber-400/10" : "border-white/12"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-xs text-amber-300">{s.code}</span>
                {current === s.code && <span className="text-[10px] font-bold text-amber-300">ACTUAL</span>}
              </div>
              <div className="font-semibold text-white">{s.name}</div>
              {s.location && <div className="text-xs text-white/45">{s.location}</div>}
            </button>
          ))}
          <button
            onClick={() => onSelect(null)}
            className={`text-left rounded-xl border p-4 transition-all hover:border-white/40 hover:bg-white/5 ${
              current === null ? "border-white/30" : "border-white/12 border-dashed"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <MonitorSmartphone size={16} className="text-white/60" />
              <span className="text-sm font-semibold text-white/80">Pantalla sin identificar</span>
            </div>
            <div className="text-xs text-white/45">Anónima — solo muestra contenido, no reporta identidad</div>
          </button>
        </div>

        <div className="flex justify-between items-center mt-6">
          <span className="text-xs text-white/35">Actual: {current ?? "sin identificar"}</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white font-medium text-sm transition-colors"
          >
            Cerrar
          </button>
        </div>
      </motion.div>
    </div>
  )
}
