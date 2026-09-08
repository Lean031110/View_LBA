"use client"

import { useRef, useState } from "react"
import { ImagePlus, Upload, X, Loader2 } from "lucide-react"
import { uploadFile } from "./api"

/** Campo de subida de imagen con vista previa. */
export default function ImageUploadField({
  value,
  onChange,
  label,
  accept = "image/*",
  aspect = "aspect-video",
}: {
  value: string | null
  onChange: (url: string | null) => void
  label?: string
  accept?: string
  aspect?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const url = await uploadFile(file)
      onChange(url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {label && <span className="text-sm font-medium text-white/80">{label}</span>}
      <div
        className={`relative rounded-xl border border-dashed border-white/15 overflow-hidden ${aspect} bg-white/[0.03] group cursor-pointer`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
      >
        {value ? (
          <>
            {accept.includes("video") && /\.(mp4|webm|ogg)$/i.test(value) ? (
              <video src={value} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
            ) : (
              <img src={value} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <span className="flex items-center gap-2 text-white text-sm font-medium bg-black/60 rounded-lg px-3 py-2">
                <Upload size={16} /> Reemplazar
              </span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
              }}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors"
              aria-label="Quitar imagen"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40 group-hover:text-white/70 transition-colors">
            {busy ? (
              <Loader2 size={26} className="animate-spin text-amber-400" />
            ) : (
              <>
                <ImagePlus size={26} />
                <span className="text-xs font-medium">Haz clic o arrastra una {accept.includes("video") ? "imagen o video" : "imagen"}</span>
              </>
            )}
          </div>
        )}
        {busy && value && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 size={26} className="animate-spin text-amber-400" />
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ""
        }}
      />
    </div>
  )
}
