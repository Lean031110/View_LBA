/**
 * ViewLBA — ZIP mínimo para licencias (cero dependencias).
 *
 * POR QUÉ hand-rolled: el sistema de licencias solo necesita leer/escribir
 * ZIPs diminutos (license.json + README.txt, unos KB). En lugar de añadir
 * una dependencia nueva al producto, se implementa el subconjunto estable
 * del formato PKZIP:
 *   · Escritura: método STORE (sin compresión — válido para cualquier
 *     unzip del SO, tamaño trivial para licencias).
 *   · Lectura: STORE + DEFLATE (zlib.inflateRawSync) con verificación CRC32.
 *
 * Límites defensivos (anti zip-bomb, licencias diminutas):
 *   ≤ 100 entradas, ≤ 10 MB por entrada, nombres ≤ 200 chars.
 */

import { inflateRawSync } from "node:zlib"

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3, tabla estándar)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Utilidades binarias
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50 // PK\x03\x04
const SIG_CD = 0x02014b50 // PK\x01\x02
const SIG_EOCD = 0x06054b50 // PK\x05\x06

function u16le(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off)
}
function u32le(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off)
}

/** Fecha/hora DOS (2+2 bytes) desde un Date. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { time, date }
}

// ---------------------------------------------------------------------------
// Escritura (STORE)
// ---------------------------------------------------------------------------

export interface ZipEntryInput {
  name: string
  data: Buffer
}

/** Construye un ZIP (STORE) con las entradas dadas. */
export function buildZip(entries: ZipEntryInput[], when = new Date()): Buffer {
  if (entries.length === 0) throw new Error("ZIP sin entradas")
  if (entries.length > 100) throw new Error("Demasiadas entradas para un ZIP de licencia")
  const { time, date } = dosDateTime(when)

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    if (entry.name.length === 0 || entry.name.length > 200) throw new Error(`Nombre de entrada ZIP inválido: "${entry.name.slice(0, 40)}…"`)
    if (entry.data.length > 10 * 1024 * 1024) throw new Error(`Entrada ZIP demasiado grande: ${entry.name}`)

    const nameBuf = Buffer.from(entry.name, "utf8")
    const crc = crc32(entry.data)

    // Local file header (30 bytes fijos + nombre)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed (2.0)
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8
    local.writeUInt16LE(0, 8) // method: STORE
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18) // compressed = uncompressed (STORE)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len

    locals.push(local, nameBuf, entry.data)

    // Central directory header (46 bytes fijos + nombre)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CD, 0)
    central.writeUInt16LE(0x031e, 4) // version made by (UNIX, 3.0)
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10) // STORE
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0o644 << 16, 38) // external attrs (unix 0644)
    central.writeUInt32LE(offset, 42) // offset del local header
    centrals.push(central, nameBuf)

    offset += 30 + nameBuf.length + entry.data.length
  }

  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cdBuf, eocd])
}

// ---------------------------------------------------------------------------
// Lectura (STORE + DEFLATE) con verificación CRC
// ---------------------------------------------------------------------------

export interface ZipExtractedEntry {
  name: string
  data: Buffer
  method: number
}

/**
 * Lee un ZIP y extrae sus entradas (STORE y DEFLATE), verificando CRC32.
 * @throws Error descriptivo si el ZIP está corrupto o excede los límites.
 */
export function readZip(zip: Buffer): ZipExtractedEntry[] {
  if (zip.length < 22) throw new Error("ZIP truncado (demasiado pequeño)")

  // 1) Localizar EOCD (escaneo hacia atrás; el comentario final es raro pero legal)
  let eocdOff = -1
  const scanStart = Math.max(0, zip.length - 22 - 65535)
  for (let i = zip.length - 22; i >= scanStart; i--) {
    if (u32le(zip, i) === SIG_EOCD) {
      eocdOff = i
      break
    }
  }
  if (eocdOff < 0) throw new Error("ZIP inválido: no se encontró el directorio central")

  const diskNo = u16le(zip, eocdOff + 4)
  const cdDisk = u16le(zip, eocdOff + 6)
  const entriesThisDisk = u16le(zip, eocdOff + 8)
  const totalEntries = u16le(zip, eocdOff + 10)
  const cdSize = u32le(zip, eocdOff + 12)
  const cdOffset = u32le(zip, eocdOff + 16)

  if (diskNo !== 0 || cdDisk !== 0) throw new Error("ZIP multi-disco no soportado")
  if (totalEntries !== entriesThisDisk) throw new Error("ZIP inconsistente")
  if (totalEntries > 100) throw new Error("ZIP con demasiadas entradas")
  if (cdOffset + cdSize > eocdOff) throw new Error("Directorio central corrupto")

  // 2) Iterar el central directory
  const out: ZipExtractedEntry[] = []
  let p = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > zip.length || u32le(zip, p) !== SIG_CD) throw new Error(`Entrada ${i} del directorio central corrupta`)
    const method = u16le(zip, p + 10)
    const crc = u32le(zip, p + 16)
    const compSize = u32le(zip, p + 20)
    const uncompSize = u32le(zip, p + 24)
    const nameLen = u16le(zip, p + 28)
    const extraLen = u16le(zip, p + 30)
    const commentLen = u16le(zip, p + 32)
    const localOffset = u32le(zip, p + 42)
    if (uncompSize > 10 * 1024 * 1024) throw new Error("Entrada ZIP demasiado grande (límite 10 MB)")
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8")
    if (name.length === 0 || name.length > 200) throw new Error("Nombre de entrada ZIP inválido")

    // 3) Saltar al data del local header correspondiente
    if (localOffset + 30 > zip.length || u32le(zip, localOffset) !== SIG_LOCAL) throw new Error(`Header local corrupto para "${name}"`)
    const lNameLen = u16le(zip, localOffset + 26)
    const lExtraLen = u16le(zip, localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const dataEnd = dataStart + compSize
    if (dataEnd > zip.length) throw new Error(`Datos truncados para "${name}"`)
    const raw = zip.subarray(dataStart, dataEnd)

    // 4) Descomprimir según método
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch {
        throw new Error(`No se pudo descomprimir "${name}" (DEFLATE corrupto)`)
      }
    } else {
      throw new Error(`Método de compresión no soportado (${method}) en "${name}"`)
    }

    // 5) Verificar CRC (integridad real del contenido)
    if (data.length !== uncompSize) throw new Error(`Tamaño inesperado en "${name}" (esperado ${uncompSize}, obtenido ${data.length})`)
    if (crc32(data) !== crc) throw new Error(`CRC32 inválido en "${name}" — el ZIP está corrupto o fue manipulado`)

    out.push({ name, data, method })
    p += 46 + nameLen + extraLen + commentLen
  }

  return out
}

/** Busca una entrada por nombre exacto (o basename si viene con path). */
export function findZipEntry(entries: ZipExtractedEntry[], name: string): ZipExtractedEntry | null {
  const direct = entries.find((e) => e.name === name)
  if (direct) return direct
  // tolerante: "license.json" dentro de "carpeta/license.json"
  return entries.find((e) => e.name.endsWith("/" + name)) ?? null
}
