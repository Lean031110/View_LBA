"use client"

import { motion } from "framer-motion"
import { KeyRound, MonitorPlay, MonitorSmartphone } from "lucide-react"

/** Selector de identidad: ¿qué pantalla física es este dispositivo? */
export default function ScreenPicker({
  screens,
  current,
  onSelect,
  onClose,
  pairCode,
  pairError,
}: {
  screens: { code: string; name: string; location: string | null }[]
  current: string | null
  onSelect: (code: string | null) => void
  onClose: () => void
  /** FASE 32: código temporal de vinculación (solo TV sin identidad) */
  pairCode?: string | null
  pairError?: string | null
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
          Vincula esta pantalla desde el panel de administración con el código de abajo, o selecciona qué pantalla
          física es este dispositivo. La asociación se guarda en el navegador y permite al panel monitorearla y
          enviarle comandos remotos. (Podrás cambiarla más tarde pulsando la tecla{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/80">S</kbd>).
        </p>

        {pairCode && (
          <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-5">
            <div className="flex items-center gap-2 mb-3">
              <KeyRound size={18} style={{ color: "var(--tv-primary)" }} />
              <span className="text-sm font-semibold text-white">Vincular esta pantalla</span>
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-amber-300/80">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                esperando vinculación
              </span>
            </div>
            <div data-testid="pair-code" className="font-mono text-4xl font-bold tracking-[0.35em] text-amber-300 mb-3 select-all">{pairCode}</div>
            <p className="text-xs text-white/50 leading-relaxed">
              En el panel de administración: <b className="text-white/75">Pantallas → Nueva pantalla</b> e introduce
              este código. La pantalla recibirá su token automáticamente y quedará verificada. El código caduca a los
              10 minutos y se renueva solo.
            </p>
            {pairError && <p className="text-xs text-red-400 mt-2">⚠ {pairError}</p>}
          </div>
        )}

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
