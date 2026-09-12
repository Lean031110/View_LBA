/**
 * ViewLBA — Lector/escritor ZIP mínimo, autocontenido y PARANOID.
 *
 * ¿Por qué implementación propia en vez de una librería?
 *  1. Cero dependencias nuevas en el binario de producción.
 *  2. Control TOTAL del parsing: el lector aplica las reglas de seguridad
 *     ANTES de devolver cualquier entrada (paths, tipos, límites, cifrado).
 *  3. El objetivo NO es leer cualquier ZIP del mundo, sino solo .vtheme
 *     bien formados: cualquier desviación → rechazo (fail-closed).
 *
 * Formato leído: End of Central Directory (EOCD) → Central Directory
 * (entradas con nombre, método, tamaños, atributos) → Local File Header +
 * datos (STORED=0 / DEFLATE=8 vía node:zlib).
 *
 * FAIL-CLOSED en TODO: estructura inesperada, tamaños inconsistentes,
 * entry cifrada, método desconocido, suma de tamaños desorbitada → error.
 * El DECOMPRESS de cada entrada se hace con LÍMITE DURO de bytes de salida
 * (inflateRaw con presupuesto) → una bomba se corta antes de asignar memoria.
 */
import { inflateRawSync } from "node:zlib"
import { THEME_LIMITS, ThemeError } from "./types"

// ---------------------------------------------------------------------------
// Lector
// ---------------------------------------------------------------------------

export interface ZipEntry {
  /** Nombre de la entrada TAL CUAL está en el ZIP (ya validado seguro). */
  name: string
  /** true si es un directorio (nombre termina en /). */
  isDirectory: boolean
  /** Método de compresión (0 = stored, 8 = deflate). */
  method: number
  /** Tamaño comprimido (bytes). */
  compressedSize: number
  /** Tamaño descomprimido declarado (bytes). */
  uncompressedSize: number
  /** CRC32 declarado. */
  crc32: number
  /** Contenido descomprimido SOLO de las entradas que se piden (lazy). */
  read(): Buffer
}

interface RawEntry {
  name: string
  isDirectory: boolean
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  crc32: number
  localHeaderOffset: number
  mode: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** Bytes seguros permitidos en nombres de entrada (ASCII imprimible útil). */
const SAFE_NAME_RE = /^[A-Za-z0-9._\-/]+$/

/**
 * Lee el índice de un buffer ZIP VALIDÁNDOLO por completo.
 * Devuelve las entradas con acceso lazy a su contenido (con límite).
 * Cualquier anomalía estructural → ThemeError (fail-closed).
 */
export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ThemeError("not_zip", "Archivo demasiado pequeño para ser un ZIP")
  if (buf.length > THEME_LIMITS.maxPackageBytes) throw new ThemeError("too_big", "Paquete demasiado grande")

  // ---- EOCD (buscar desde el final; comentario máx. 65.535 bytes) ----
  const scanStart = Math.max(0, buf.length - 22 - 65_536)
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new ThemeError("not_zip", "No es un archivo ZIP (sin EOCD)")

  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)

  // Coherencia dura: el central directory DEBE caber en el buffer.
  if (cdOffset > buf.length || cdOffset + cdSize > eocdOffset + 22) {
    throw new ThemeError("zip_corrupt", "Central directory fuera de rango")
  }
  if (entryCount > THEME_LIMITS.maxEntries) {
    throw new ThemeError("too_many_entries", `Demasiadas entradas en el paquete (máx. ${THEME_LIMITS.maxEntries})`)
  }

  // ---- Central Directory ----
  const raw: RawEntry[] = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ThemeError("zip_corrupt", "Entrada del central directory inválida")
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc32 = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttrs = buf.readUInt32LE(p + 38)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) {
      throw new ThemeError("zip_corrupt", "Nombre de entrada fuera de rango")
    }
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)

    // Modo Unix (alto 16 bits de external attrs; 0 = FAT → archivo regular)
    const mode = (externalAttrs >>> 16) & 0xffff

    raw.push({ name, isDirectory: name.endsWith("/"), method, flags, compressedSize, uncompressedSize, crc32, localHeaderOffset, mode })
    p += 46 + nameLen + extraLen + commentLen
  }
  // El central directory consumió EXACTAMENTE lo declarado
  if (p !== cdOffset + cdSize) throw new ThemeError("zip_corrupt", "Central directory inconsistente con EOCD")

  // ---- Validación de cada nombre de entrada (§11: path traversal) ----
  const seen = new Set<string>()
  let totalUncompressed = 0
  for (const e of raw) {
    validateEntryName(e.name)

    // Duplicados exactos (§10.15)
    if (seen.has(e.name)) throw new ThemeError("duplicate", `Entrada duplicada: ${e.name}`)
    seen.add(e.name)

    // Entrada CIFRADA (flag bit 0) → rechazo (no pedimos contraseñas)
    if ((e.flags & 0x1) !== 0) throw new ThemeError("encrypted_entry", `Entrada cifrada: ${e.name}`)

    // Solo STORED(0) y DEFLATE(8)
    if (!e.isDirectory && e.method !== 0 && e.method !== 8) {
      throw new ThemeError("bad_compression", `Método de compresión no soportado (${e.method})`)
    }

    // Symlinks y especiales (§10.8): el modo Unix S_IFMT debe ser archivo o dir
    if (e.mode !== 0) {
      const type = e.mode & 0xf000
      if (type !== 0x8000 && type !== 0x4000) {
        // 0xA000 = symlink; 0x4000 = dir; resto → rechazo
        throw new ThemeError("symlink", `Entrada no regular (symlink/dispositivo): ${e.name}`)
      }
    }

    // Tamaños coherentes con el buffer
    if (e.compressedSize > buf.length) throw new ThemeError("zip_corrupt", "Tamaño comprimido imposible")

    // Presupuesto global de descompresión (§12) — antes de leer nada
    totalUncompressed += e.uncompressedSize
    if (totalUncompressed > THEME_LIMITS.maxUncompressedBytes) {
      throw new ThemeError("uncompressed_limit", "Contenido descomprimido total excede el límite")
    }

    // Sospecha de bomba (ratio) para entradas ya grandes comprimidas
    if (
      !e.isDirectory &&
      e.compressedSize > THEME_LIMITS.bombRatioMinCompressed &&
      e.compressedSize > 0 &&
      e.uncompressedSize / e.compressedSize > THEME_LIMITS.bombRatio
    ) {
      throw new ThemeError("bomb_suspected", `Ratio de compresión imposible (${Math.round(e.uncompressedSize / e.compressedSize)}×)`)
    }
  }

  // ---- Envolver con lectura LAZY (validada de nuevo al leer) ----
  const readEntry = (e: RawEntry): Buffer => {
    if (e.isDirectory) return Buffer.alloc(0)
    const lho = e.localHeaderOffset
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LOC_SIG) {
      throw new ThemeError("zip_corrupt", "Local header inválido")
    }
    const lnameLen = buf.readUInt16LE(lho + 26)
    const lextraLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lnameLen + lextraLen
    const dataEnd = dataStart + e.compressedSize
    if (dataEnd > buf.length) throw new ThemeError("zip_corrupt", "Datos de entrada fuera de rango")

    const raw_ = buf.subarray(dataStart, dataEnd)
    let out: Buffer
    if (e.method === 0) {
      out = Buffer.from(raw_) // stored: copia (el buf original puede mutar)
    } else {
      // DEFLATE con tope duro: un entry que declare menos de lo que infla
      // se corta (bombas declaran tamaños pequeños y devuelven gigantes).
      out = inflateWithLimit(raw_, e.uncompressedSize)
    }

    // Tamaño REAL == declarado (discrepancia = mentira estructural)
    if (out.length !== e.uncompressedSize) {
      throw new ThemeError("zip_corrupt", `Tamaño real ≠ declarado (${e.name})`)
    }
    // CRC32 (defensa extra: contenido íntegro; data descriptor no aceptado)
    if (crc32Of(out) !== e.crc32) {
      throw new ThemeError("zip_corrupt", `CRC32 inválido (${e.name})`)
    }
    return out
  }

  return raw.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory,
    method: e.method,
    compressedSize: e.compressedSize,
    uncompressedSize: e.uncompressedSize,
    crc32: e.crc32,
    read: () => readEntry(e),
  }))
}

/** Infla DEFLATE con presupuesto de salida (corta bombas). */
function inflateWithLimit(data: Buffer, expectedSize: number): Buffer {
  // El tamaño esperado ya está presupuestado por el límite global; el corte
  // real lo hace el chequeo posterior de length. Para expectedSize gigante
  // (ya rechazado arriba) nunca llegamos aquí.
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(expectedSize, 1) })
  } catch {
    throw new ThemeError("zip_corrupt", "Entrada DEFLATE corrupta o excede el tamaño declarado")
  }
}

/** Valida el NOMBRE de una entrada (§11). ASCII seguro, relativo, sin ../ */
export function validateEntryName(name: string): void {
  if (name.length === 0) throw new ThemeError("entry_name_invalid", "Nombre de entrada vacío")
  if (name.length > THEME_LIMITS.maxEntryNameLength) {
    throw new ThemeError("entry_name_invalid", "Nombre de entrada demasiado largo")
  }
  // Separador de Windows y rutas absolutas PRIMERO (error específico §11)
  if (name.includes("\\")) throw new ThemeError("traversal", "Separador de Windows no permitido (\\)")
  if (name.startsWith("/")) throw new ThemeError("traversal", "Ruta absoluta no permitida")
  // Charset estricto: sin espacios, unicode, NUL ni control (SAFE_NAME_RE)
  if (!SAFE_NAME_RE.test(name)) {
    throw new ThemeError("entry_name_invalid", "Caracteres no permitidos en el nombre de entrada")
  }
  if (name.includes("//")) throw new ThemeError("entry_name_invalid", "Ruta con componentes vacíos")
  // ../ en cualquier componente (incluye codificaciones obvias)
  for (const seg of name.split("/")) {
    if (seg === "..") throw new ThemeError("traversal", "Componente '..' no permitido")
  }
  // Dispositivos Windows clásicos (CON, NUL, AUX…) como nombre base
  const base = name.split("/").pop() ?? ""
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(base)) {
    throw new ThemeError("entry_name_invalid", "Nombre de dispositivo reservado")
  }
  const depth = name.split("/").filter(Boolean).length
  if (depth > THEME_LIMITS.maxPathDepth) {
    throw new ThemeError("entry_name_invalid", `Profundidad de ruta excedida (máx. ${THEME_LIMITS.maxPathDepth})`)
  }
}

// ---------------------------------------------------------------------------
// CRC32 (PKZIP/DEFLATE estándar — IEEE 802.3 polinomio reflejado)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Of(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Escritor (STORED — determinista, sin compresión; para build/e2e/fixtures)
// ---------------------------------------------------------------------------

/** Escribe un ZIP STORED mínimo con las entradas dadas (orden preservado). */
export function writeZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8")
    // Local file header
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(LOC_SIG, 0)
    loc.writeUInt16LE(20, 4) // version needed
    loc.writeUInt16LE(0, 6) // flags (sin cifrado, sin descriptor)
    loc.writeUInt16LE(0, 8) // method = stored
    loc.writeUInt16LE(0, 10) // mod time
    loc.writeUInt16LE(0x21, 12) // mod date (1980-01-01 determinista)
    loc.writeUInt32LE(crc32Of(f.data), 14)
    loc.writeUInt32LE(f.data.length, 18) // compressed
    loc.writeUInt32LE(f.data.length, 22) // uncompressed
    loc.writeUInt16LE(nameBuf.length, 26)
    loc.writeUInt16LE(0, 28) // extra len
    chunks.push(loc, nameBuf, f.data)

    // Central directory entry
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(20, 4) // version made by (DOS, sin modo Unix → regular)
    cen.writeUInt16LE(20, 6) // version needed
    cen.writeUInt16LE(0, 8) // flags
    cen.writeUInt16LE(0, 10) // method
    cen.writeUInt16LE(0, 12) // time
    cen.writeUInt16LE(0x21, 14) // date
    cen.writeUInt32LE(crc32Of(f.data), 16)
    cen.writeUInt32LE(f.data.length, 20)
    cen.writeUInt32LE(f.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30) // extra
    cen.writeUInt16LE(0, 32) // comment
    cen.writeUInt16LE(0, 34) // disk
    cen.writeUInt16LE(0, 36) // internal attrs
    cen.writeUInt32LE(0, 38) // external attrs (DOS regular)
    cen.writeUInt32LE(offset, 42) // local header offset
    central.push(cen, nameBuf)

    offset += 30 + nameBuf.length + f.data.length
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // sin comentario

  return Buffer.concat([...chunks, ...central, eocd])
}
