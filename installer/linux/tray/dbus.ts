/**
 * dbus.ts — Cliente D-Bus en TypeScript PURO (node:net) para la bandeja de
 * ViewLBA (Linux).
 *
 * POR QUÉ ESTE ARCHIVO EXISTE (misión: instaladores 100 % offline):
 *   La bandeja anterior era Python3 + PyGObject (python3-gi) + GTK +
 *   gir1.2-ayatanaappindicator — dependencias del SISTEMA que `dpkg -i` NO
 *   instala offline (eran solo «Recommends»). En una máquina sin python3-gi
 *   la bandeja NO ARRANCABA y, sin red, no había forma de instalarla.
 *   Esta implementación usa SOLO el runtime bun que YA VIAJA DENTRO del
 *   .deb (`/opt/viewlba-server/runtime/bun`) + el protocolo D-Bus hablado
 *   directamente sobre el socket Unix de la sesión. CERO dependencias del
 *   sistema más allá de lo que todo escritorio Linux tiene de todos modos
 *   (dbus-daemon y el host StatusNotifier: KDE/XFCE/MATE/Cinnamon nativos,
 *   Ubuntu GNOME vía gnome-shell-extension-appindicator, preinstalado).
 *
 * QUÉ IMPLEMENTA (firmas verificadas contra DOS fuentes independientes:
 * ksni —lado servidor— y gnome-shell-extension-appindicator —lado consumidor—;
 * reglas de marshalling del spec oficial dbus.freedesktop.org):
 *   · Wire format completo: tipos y/b/n/q/i/u/x/t/d/s/o/g/v/a/()/{} con
 *     sus alineaciones (STRUCT y DICT_ENTRY a 8; ARRAY: u32 de longitud
 *     alineado a 4 + padding al tipo de elemento —incluso vacío—; VARIANT
 *     alineado a 1 con firma embebida).
 *   · Mensajes: METHOD_CALL / METHOD_RETURN / ERROR / SIGNAL con cabecera
 *     fija de 12 bytes + array a(yv) + cuerpo alineado a 8.
 *   · Autenticación SASL EXTERNAL (uid del socket Unix — sin credenciales).
 *   · Llamadas con correlación serial↔respuesta y timeout.
 *   · Lado SERVIDOR: objetos exportables con métodos, propiedades
 *     (org.freedesktop.DBus.Properties), introspección XML autogenerada,
 *     org.freedesktop.DBus.Peer.Ping.
 *
 * USO (desde tray.ts):
 *   const conn = await DBusConnection.connect()
 *   const [owner] = await conn.call("org.freedesktop.DBus", "/org/freedesktop/DBus",
 *                                    "org.freedesktop.DBus", "GetNameOwner", "s", ["org.kde.StatusNotifierWatcher"])
 */

import net from "node:net"
import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Tipos de valor (representación JS de cada tipo D-Bus)
// ---------------------------------------------------------------------------

/** Envoltorio de variante: la firma viaja CON el valor (tipo 'v'). */
export class Variant {
  constructor(readonly sig: string, readonly value: unknown) {}
}

export interface DBusSignal {
  path: string
  iface: string
  member: string
  sender?: string
  args: unknown[]
}

export class DBusError extends Error {
  constructor(readonly errorName: string, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Firma de tipos → árbol de nodos
// ---------------------------------------------------------------------------

type TypeNode =
  | { k: "basic"; code: string }
  | { k: "variant" }
  | { k: "array"; child: TypeNode }
  | { k: "struct"; children: TypeNode[] }
  | { k: "dictentry"; key: TypeNode; value: TypeNode }

const BASIC_CODES = "ybnqiuxtdsog"

function alignmentOf(node: TypeNode): number {
  switch (node.k) {
    case "basic":
      switch (node.code) {
        case "y":
        case "g":
          return 1
        case "n":
        case "q":
          return 2
        case "b":
        case "i":
        case "u":
        case "s":
        case "o":
          return 4
        case "x":
        case "t":
        case "d":
          return 8
        default:
          throw new Error(`código básico desconocido: ${node.code}`)
      }
    case "variant":
      return 1 // el spec: el VARIANT se alinea como su firma embebida (1)
    case "array":
      return 4 // el u32 de longitud (los ELEMENTOS se alinean aparte)
    case "struct":
    case "dictentry":
      return 8
  }
}

/** Divide una firma completa en la lista de nodos de tipos completos. */
export function parseSignature(sig: string): TypeNode[] {
  const out: TypeNode[] = []
  let pos = 0
  while (pos < sig.length) {
    const [node, next] = parseOne(sig, pos)
    out.push(node)
    pos = next
  }
  return out
}

function parseOne(sig: string, pos: number): [TypeNode, number] {
  const c = sig[pos]
  if (c === "v") return [{ k: "variant" }, pos + 1]
  if (BASIC_CODES.includes(c)) return [{ k: "basic", code: c }, pos + 1]
  if (c === "a") {
    const [child, next] = parseOne(sig, pos + 1)
    return [{ k: "array", child }, next]
  }
  if (c === "(") {
    const children: TypeNode[] = []
    let p = pos + 1
    while (sig[p] !== ")") {
      if (p >= sig.length) throw new Error(`struct sin cerrar en ${sig.slice(pos)}`)
      const [child, next] = parseOne(sig, p)
      children.push(child)
      p = next
    }
    return [{ k: "struct", children }, p + 1]
  }
  if (c === "{") {
    const [key, p1] = parseOne(sig, pos + 1)
    const [value, p2] = parseOne(sig, p1)
    if (sig[p2] !== "}") throw new Error(`dict entry sin cerrar en ${sig.slice(pos)}`)
    return [{ k: "dictentry", key, value }, p2 + 1]
  }
  throw new Error(`carácter inválido en firma: '${c}' (firma: ${sig})`)
}

/** Renderiza un nodo de vuelta a firma (introspección / variantes). */
export function renderSignature(node: TypeNode): string {
  switch (node.k) {
    case "basic":
      return node.code
    case "variant":
      return "v"
    case "array":
      return "a" + renderSignature(node.child)
    case "struct":
      return "(" + node.children.map(renderSignature).join("") + ")"
    case "dictentry":
      return "{" + renderSignature(node.key) + renderSignature(node.value) + "}"
  }
}

// ---------------------------------------------------------------------------
// Writer / Reader (little-endian — byte 0 del mensaje = 'l')
// ---------------------------------------------------------------------------

class Writer {
  private parts: Buffer[] = []
  private len = 0
  /** Longitudes de array pendientes de parchear: [posición del u32, inicio de datos, fin de datos]. */
  private arrayPatches: Array<[number, number, number]> = []

  get offset(): number {
    return this.len
  }

  private push(buf: Buffer): void {
    this.parts.push(buf)
    this.len += buf.length
  }

  raw(bytes: Buffer): void {
    this.push(Buffer.from(bytes))
  }

  byte(v: number): void {
    this.push(Buffer.from([v & 0xff]))
  }

  u16(v: number): void {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v >>> 0, 0)
    this.push(b)
  }

  u32(v: number): void {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0, 0)
    this.push(b)
  }

  u64(v: bigint): void {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt.asUintN(64, v), 0)
    this.push(b)
  }

  f64(v: number): void {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(v, 0)
    this.push(b)
  }

  /** Alinea escribiendo ceros (el spec exige padding a valor NULO). */
  align(n: number): void {
    if (n <= 1) return
    const pad = (n - (this.len % n)) % n
    if (pad > 0) this.raw(Buffer.alloc(pad))
  }

  /** Registra un u32 «longitud de array» para parchearlo al final (se llama DESPUÉS de escribir los elementos). */
  markArrayLength(lenFieldPos: number, dataStart: number): void {
    this.arrayPatches.push([lenFieldPos, dataStart, this.len])
  }

  take(): Buffer {
    const all = Buffer.concat(this.parts, this.len)
    for (const [pos, dataStart, dataEnd] of this.arrayPatches) {
      all.writeUInt32LE(dataEnd - dataStart, pos)
    }
    return all
  }
}

class Reader {
  pos = 0

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos
  }

  align(n: number): void {
    if (n <= 1) return
    this.pos += (n - (this.pos % n)) % n
  }

  byte(): number {
    return this.buf[this.pos++]
  }

  u16(): number {
    this.align(2)
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }

  i16(): number {
    this.align(2)
    const v = this.buf.readInt16LE(this.pos)
    this.pos += 2
    return v
  }

  u32(): number {
    this.align(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  i32(): number {
    this.align(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }

  u64(): bigint {
    this.align(8)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    return v
  }

  f64(): number {
    this.align(8)
    const v = this.buf.readDoubleLE(this.pos)
    this.pos += 8
    return v
  }

  str(): string {
    const n = this.u32()
    const s = this.buf.toString("utf8", this.pos, this.pos + n)
    this.pos += n + 1 // + NUL
    return s
  }

  sig(): string {
    const n = this.byte()
    const s = this.buf.toString("utf8", this.pos, this.pos + n)
    this.pos += n + 1
    return s
  }
}

// ---------------------------------------------------------------------------
// Marshalling valor por valor
// ---------------------------------------------------------------------------

function writeValue(w: Writer, node: TypeNode, v: unknown): void {
  switch (node.k) {
    case "basic":
      writeBasic(w, node.code, v)
      break
    case "variant": {
      if (!(v instanceof Variant)) {
        throw new Error(`se esperaba una instancia de Variant para tipo 'v' (recibido: ${typeof v})`)
      }
      // firma embebida (u8 len + bytes + NUL — alineación 1)
      const sigBytes = Buffer.from(v.sig, "utf8")
      if (sigBytes.length > 255) throw new Error("firma de variante > 255 bytes")
      w.byte(sigBytes.length)
      w.raw(sigBytes)
      w.byte(0)
      const [child] = parseSignature(v.sig)
      if (!child) throw new Error(`firma de variante vacía: '${v.sig}'`)
      writeValue(w, child, v.value)
      break
    }
    case "array": {
      if (!Array.isArray(v)) throw new Error(`se esperaba array para tipo 'a' (recibido: ${typeof v})`)
      w.align(4) // u32 de longitud
      const lenFieldPos = w.offset
      w.u32(0) // placeholder — parcheado en take()
      const elemAlign = alignmentOf(node.child)
      w.align(elemAlign) // el spec: el padding del 1.er elemento va SIEMPRE (array vacío incluido)
      const dataStart = w.offset
      for (const el of v) writeValue(w, node.child, el)
      w.markArrayLength(lenFieldPos, dataStart)
      break
    }
    case "struct": {
      if (!Array.isArray(v)) throw new Error(`se esperaba array (struct) para tipo '()' (recibido: ${typeof v})`)
      if (v.length !== node.children.length) {
        throw new Error(`struct espera ${node.children.length} campos, recibidos ${v.length}`)
      }
      w.align(8)
      for (let i = 0; i < node.children.length; i++) writeValue(w, node.children[i], v[i])
      break
    }
    case "dictentry": {
      if (!Array.isArray(v) || v.length !== 2) throw new Error(`dict entry espera [clave, valor]`)
      w.align(8)
      writeValue(w, node.key, v[0])
      writeValue(w, node.value, v[1])
      break
    }
  }
}

function writeBasic(w: Writer, code: string, v: unknown): void {
  switch (code) {
    case "y":
      w.align(1)
      w.byte(Number(v))
      break
    case "b":
      w.align(4)
      w.u32(v ? 1 : 0)
      break
    case "n":
    case "q":
      w.align(2)
      w.u16(Number(v))
      break
    case "i":
      w.align(4)
      w.u32(Number(v) | 0)
      break
    case "u":
      w.align(4)
      w.u32(Number(v) >>> 0)
      break
    case "x":
    case "t":
      w.align(8)
      w.u64(BigInt(v as never))
      break
    case "d":
      w.align(8)
      w.f64(Number(v))
      break
    case "s":
    case "o": {
      w.align(4)
      const bytes = Buffer.from(String(v), "utf8")
      w.u32(bytes.length)
      w.raw(bytes)
      w.byte(0)
      break
    }
    case "g": {
      const bytes = Buffer.from(String(v), "utf8")
      w.byte(bytes.length)
      w.raw(bytes)
      w.byte(0)
      break
    }
    default:
      throw new Error(`tipo no soportado: ${code}`)
  }
}

// ---------------------------------------------------------------------------
// Lectura valor por valor
// ---------------------------------------------------------------------------

function readValue(r: Reader, node: TypeNode): unknown {
  switch (node.k) {
    case "basic":
      return readBasic(r, node.code)
    case "variant": {
      const sig = r.sig()
      const [child] = parseSignature(sig)
      // se devuelve ENVUELTO (Variant) para no perder la firma — simétrico
      // con la escritura (las variantes escritas también son Variant)
      return new Variant(sig, readValue(r, child))
    }
    case "array": {
      r.align(4)
      const n = r.u32()
      r.align(alignmentOf(node.child))
      const end = r.pos + n
      const out: unknown[] = []
      while (r.pos < end) out.push(readValue(r, node.child))
      r.pos = end
      return out
    }
    case "struct": {
      r.align(8)
      return node.children.map((c) => readValue(r, c))
    }
    case "dictentry": {
      r.align(8)
      const key = readValue(r, node.key)
      const value = readValue(r, node.value)
      return [key, value]
    }
  }
}

function readBasic(r: Reader, code: string): unknown {
  switch (code) {
    case "y":
      return r.byte()
    case "b":
      return r.u32() !== 0
    case "n":
      return r.i16()
    case "q":
      return r.u16()
    case "i":
      return r.i32()
    case "u":
      return r.u32()
    case "x":
      return BigInt.asIntN(64, r.u64())
    case "t":
      return r.u64()
    case "d":
      return r.f64()
    case "s":
    case "o":
      return r.str()
    case "g":
      return r.sig()
    default:
      throw new Error(`tipo no soportado: ${code}`)
  }
}

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------

export const MSG_METHOD_CALL = 1
export const MSG_METHOD_RETURN = 2
export const MSG_ERROR = 3
export const MSG_SIGNAL = 4

export const FLAG_NO_REPLY = 0x01
export const FLAG_NO_AUTO_START = 0x02

export interface Message {
  type: number
  flags: number
  serial: number
  path?: string
  iface?: string
  member?: string
  errorName?: string
  replySerial?: number
  destination?: string
  sender?: string
  signature?: string
  body: unknown[]
}

const FIELD_PATH = 1
const FIELD_INTERFACE = 2
const FIELD_MEMBER = 3
const FIELD_ERROR_NAME = 4
const FIELD_REPLY_SERIAL = 5
const FIELD_DESTINATION = 6
const FIELD_SENDER = 7
const FIELD_SIGNATURE = 8

/** Codifica un mensaje completo (cabecera + cuerpo). */
export function encodeMessage(msg: Message, serial: number): Buffer {
  const w = new Writer()

  // cuerpo primero (necesitamos su longitud)
  const bodyW = new Writer()
  if (msg.signature) {
    const bodyNodes = parseSignature(msg.signature)
    for (let i = 0; i < bodyNodes.length; i++) writeValue(bodyW, bodyNodes[i], msg.body[i])
  }
  const body = bodyW.take()

  // cabecera fija: endian 'l', tipo, flags, versión 1, len cuerpo, serial
  w.byte(0x6c) // 'l' little-endian
  w.byte(msg.type)
  w.byte(msg.flags)
  w.byte(1)
  w.u32(body.length)
  w.u32(serial)

  // a(yv) de campos
  const fields: Array<[number, string, unknown]> = []
  if (msg.path) fields.push([FIELD_PATH, "o", msg.path])
  if (msg.iface) fields.push([FIELD_INTERFACE, "s", msg.iface])
  if (msg.member) fields.push([FIELD_MEMBER, "s", msg.member])
  if (msg.errorName) fields.push([FIELD_ERROR_NAME, "s", msg.errorName])
  if (msg.replySerial !== undefined) fields.push([FIELD_REPLY_SERIAL, "u", msg.replySerial])
  if (msg.destination) fields.push([FIELD_DESTINATION, "s", msg.destination])
  if (msg.sender) fields.push([FIELD_SENDER, "s", msg.sender])
  if (msg.signature) fields.push([FIELD_SIGNATURE, "g", msg.signature])

  w.align(4) // u32 de longitud del array
  const headLenPos = w.offset
  w.u32(0)
  w.align(8) // elementos struct(yv) → 8
  const headDataStart = w.offset
  for (const [code, sig, value] of fields) {
    w.align(8)
    w.byte(code)
    writeValue(w, { k: "variant" }, new Variant(sig, value))
  }
  w.markArrayLength(headLenPos, headDataStart)

  const head = w.take()
  const headAligned = head.length % 8 === 0 ? head : Buffer.concat([head, Buffer.alloc(8 - (head.length % 8))])

  return Buffer.concat([headAligned, body])
}

export interface ParsedMessage {
  msg: Message
  /** Bytes totales consumidos del buffer. */
  size: number
}

/**
 * Intenta parsear UN mensaje del inicio del buffer.
 * Devuelve null si aún no está completo.
 */
export function tryParseMessage(buf: Buffer): ParsedMessage | null {
  if (buf.length < 16) return null
  if (buf[0] !== 0x6c) throw new Error(`endianness no soportado: 0x${buf[0].toString(16)} (solo little-endian)`)
  const type = buf[1]
  const flags = buf[2]
  const version = buf[3]
  if (version !== 1) throw new Error(`versión de protocolo no soportada: ${version}`)
  const bodyLen = buf.readUInt32LE(4)
  const serial = buf.readUInt32LE(8)
  const arrayLen = buf.readUInt32LE(12)
  const bodyStart = align8(16 + arrayLen)
  const total = bodyStart + bodyLen
  if (buf.length < total) return null

  const msg: Message = { type, flags, serial, body: [] }
  const r = new Reader(buf)
  r.pos = 16
  const fieldsEnd = 16 + arrayLen
  while (r.pos < fieldsEnd) {
    r.align(8)
    const code = r.byte()
    const value = readValue(r, { k: "variant" })
    // los valores de cabecera siempre son básicos dentro de la variante
    const raw = value instanceof Variant ? value.value : value
    switch (code) {
      case FIELD_PATH:
        msg.path = raw as string
        break
      case FIELD_INTERFACE:
        msg.iface = raw as string
        break
      case FIELD_MEMBER:
        msg.member = raw as string
        break
      case FIELD_ERROR_NAME:
        msg.errorName = raw as string
        break
      case FIELD_REPLY_SERIAL:
        msg.replySerial = raw as number
        break
      case FIELD_DESTINATION:
        msg.destination = raw as string
        break
      case FIELD_SENDER:
        msg.sender = raw as string
        break
      case FIELD_SIGNATURE:
        msg.signature = raw as string
        break
      default:
        break // códigos desconocidos (p.ej. UNIX_FDS) se ignoran
    }
  }
  if (msg.signature && bodyLen > 0) {
    r.pos = bodyStart
    const nodes = parseSignature(msg.signature)
    for (const n of nodes) msg.body.push(readValue(r, n))
  }
  return { msg, size: total }
}

function align8(n: number): number {
  return (n + 7) & ~7
}

// ---------------------------------------------------------------------------
// Direcciones
// ---------------------------------------------------------------------------

export interface BusAddress {
  kind: "path" | "abstract"
  value: string
}

/** Parsea «unix:path=/run/user/1000/bus» / «unix:abstract=/tmp/dbus-x,guid=…». */
export function parseAddress(addr: string): BusAddress[] {
  const out: BusAddress[] = []
  for (const one of addr.split(";")) {
    if (!one.trim()) continue
    // formato: «TRANSPORTE:clave=valor,clave=valor» — p.ej. «unix:path=/x,guid=y»
    const colon = one.indexOf(":")
    if (colon < 0) continue
    const rest = one.slice(colon + 1)
    const kv: Record<string, string> = {}
    for (const part of rest.split(",")) {
      const i = part.indexOf("=")
      if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1)
    }
    if (kv.path) out.push({ kind: "path", value: kv.path })
    if (kv.abstract) out.push({ kind: "abstract", value: kv.abstract })
  }
  return out
}

// ---------------------------------------------------------------------------
// Definición de objetos exportados
// ---------------------------------------------------------------------------

export interface MethodDef {
  /** Firma de ENTRADA (args). */
  in?: string
  /** Firma de SALIDA (valores devueltos). */
  out?: string
  handler: (args: unknown[]) => unknown[] | Promise<unknown[]>
}

export interface PropDef {
  sig: string
  get: () => unknown
}

export interface InterfaceDef {
  methods: Record<string, MethodDef>
  properties?: Record<string, PropDef>
  /** Señales (solo para la introspección XML — se emiten manualmente). */
  signals?: Record<string, { sig: string }>
}

export interface ExportedObject {
  interfaces: Record<string, InterfaceDef>
}

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (values: unknown[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DBusConnection {
  private sock!: net.Socket
  private rxBuf: Buffer = Buffer.alloc(0)
  private authBuf = ""
  private authed = false
  private serial = 0
  private pending = new Map<number, Pending>()
  private objects = new Map<string, ExportedObject>()
  private signalHandlers: Array<(s: DBusSignal) => void> = []
  private disconnectHandlers: Array<(err?: Error) => void> = []
  uniqueName = ""

  private constructor() {}

  /** Conecta al bus de sesión (DBUS_SESSION_BUS_ADDRESS con fallbacks). */
  static async connect(opts: { address?: string; timeoutMs?: number } = {}): Promise<DBusConnection> {
    const addresses: string[] = []
    if (opts.address) {
      addresses.push(opts.address)
    } else {
      if (process.env.DBUS_SESSION_BUS_ADDRESS) addresses.push(process.env.DBUS_SESSION_BUS_ADDRESS)
      const uid = process.getuid?.() ?? 0
      if (process.env.XDG_RUNTIME_DIR) addresses.push(`unix:path=${process.env.XDG_RUNTIME_DIR}/bus`)
      addresses.push(`unix:path=/run/user/${uid}/bus`)
    }

    let lastErr: Error | undefined
    for (const addr of addresses) {
      for (const a of parseAddress(addr)) {
        try {
          const conn = new DBusConnection()
          await conn.dial(a, opts.timeoutMs ?? 10_000)
          return conn
        } catch (e) {
          lastErr = e as Error
        }
      }
    }
    throw new DBusError(
      "org.freedesktop.DBus.Error.NoServer",
      `no se pudo conectar al bus de sesión D-Bus (${lastErr?.message ?? "sin direcciones"})`,
    )
  }

  private dial(a: BusAddress, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const path = a.kind === "abstract" ? "\0" + a.value : a.value
      this.sock = net.connect({ path })
      this.sock.setNoDelay(true)
      let settled = false
      const timer = setTimeout(() => {
        this.sock.destroy()
        if (!settled) {
          settled = true
          reject(new Error(`timeout conectando a ${a.kind === "abstract" ? "abstract " : ""}${a.value}`))
        }
      }, timeoutMs)

      this.sock.on("error", (e: Error) => {
        if (!settled && !this.authed) {
          clearTimeout(timer)
          settled = true
          reject(e)
          return
        }
        this.failAll(new DBusError("org.freedesktop.DBus.Error.Disconnected", `conexión perdida: ${e.message}`))
        for (const cb of this.disconnectHandlers) cb(e)
      })

      this.sock.on("close", () => {
        if (this.authed) {
          this.failAll(new DBusError("org.freedesktop.DBus.Error.Disconnected", "conexión cerrada"))
          for (const cb of this.disconnectHandlers) cb()
        }
      })

      this.sock.on("connect", () => {
        // SASL: byte NUL + AUTH EXTERNAL <hex(uid ascii)>
        const uidHex = Buffer.from(String(process.getuid?.() ?? 0), "utf8").toString("hex")
        this.sock.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${uidHex}\r\n`, "utf8")]))
      })

      this.sock.on("data", (data: Buffer) => {
        if (!this.authed) {
          this.authBuf += data.toString("latin1")
          let idx: number
          while ((idx = this.authBuf.indexOf("\r\n")) >= 0) {
            const line = this.authBuf.slice(0, idx)
            this.authBuf = this.authBuf.slice(idx + 2)
            if (line.startsWith("OK ")) {
              this.sock.write(Buffer.from("BEGIN\r\n", "utf8"))
              this.authed = true
              clearTimeout(timer)
              settled = true
              resolve()
              // lo que quede en authBuf ya es binario (raro, pero seguro)
              if (this.authBuf.length > 0) {
                this.feed(Buffer.from(this.authBuf, "latin1"))
                this.authBuf = ""
              }
              return
            }
            if (line.startsWith("REJECTED")) {
              clearTimeout(timer)
              if (!settled) {
                settled = true
                this.sock.destroy()
                reject(new DBusError("org.freedesktop.DBus.Error.AuthFailed", `SASL rechazado: ${line}`))
              }
              return
            }
            // ERROR / DATA / AGREE_UNIX_FD: ignorar (no pedimos UNIX_FD)
          }
          return
        }
        this.feed(data)
      })
    })
  }

  /** Post-conexión: Hello → nombre único del bus. */
  async hello(): Promise<string> {
    const [name] = await this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "", [])
    this.uniqueName = name as string
    return this.uniqueName
  }

  // ------------------------------------------------------------- llamadas

  call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    sig: string,
    values: unknown[],
    opts: { timeoutMs?: number; flags?: number } = {},
  ): Promise<unknown[]> {
    const serial = ++this.serial
    const flags = opts.flags ?? 0
    const msg: Message = {
      type: MSG_METHOD_CALL,
      flags,
      serial,
      path,
      iface,
      member,
      destination,
      signature: sig || undefined,
      body: values,
    }
    const out = encodeMessage(msg, serial)
    if (flags & FLAG_NO_REPLY) {
      this.sock.write(out)
      return Promise.resolve([])
    }
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(new DBusError("org.freedesktop.DBus.Error.Timeout", `timeout llamando ${iface}.${member}`))
      }, opts.timeoutMs ?? 10_000)
      this.pending.set(serial, { resolve, reject, timer })
      this.sock.write(out)
    })
  }

  signal(path: string, iface: string, member: string, sig: string, values: unknown[]): void {
    const serial = ++this.serial
    const msg: Message = {
      type: MSG_SIGNAL,
      flags: 0,
      serial,
      path,
      iface,
      member,
      signature: sig || undefined,
      body: values,
    }
    this.sock.write(encodeMessage(msg, serial))
  }

  async requestName(name: string): Promise<void> {
    const [code] = await this.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "RequestName",
      "su",
      [name, 4], // DBUS_NAME_FLAG_DO_NOT_QUEUE
    )
    if (code !== 1) {
      // 1 = PRIMARY_OWNER; 3 = EXISTS (tomado por OTRA instancia de la bandeja)
      throw new DBusError("org.freedesktop.DBus.Error.NameHasNoOwner", `no se pudo obtener el nombre ${name} (código ${code})`)
    }
  }

  async addMatch(rule: string): Promise<void> {
    await this.call("org.freedesktop.DBus", "/", "org.freedesktop.DBus", "AddMatch", "s", [rule], { flags: FLAG_NO_REPLY })
  }

  onSignal(cb: (s: DBusSignal) => void): void {
    this.signalHandlers.push(cb)
  }

  onDisconnect(cb: (err?: Error) => void): void {
    this.disconnectHandlers.push(cb)
  }

  // ------------------------------------------------------------- exportados

  exportObject(path: string, interfaces: Record<string, InterfaceDef>): void {
    this.objects.set(path, { interfaces })
  }

  unexportObject(path: string): void {
    this.objects.delete(path)
  }

  /** Emite org.freedesktop.DBus.Properties.PropertiesChanged. */
  emitPropertiesChanged(path: string, iface: string, changed: Record<string, unknown>): void {
    const obj = this.objects.get(path)
    if (!obj) return
    const propsDef = obj.interfaces[iface]?.properties
    if (!propsDef) return
    const entries: Array<[string, Variant]> = Object.entries(changed).map(([k, v]) => {
      const sig = propsDef[k]?.sig ?? guessSig(v)
      return [k, new Variant(sig, v)]
    })
    this.signal(path, "org.freedesktop.DBus.Properties", "PropertiesChanged", "sa{sv}as", [
      iface,
      entries,
      [], // invalidated
    ])
  }

  // ------------------------------------------------------------- interno

  private feed(data: Buffer): void {
    this.rxBuf = this.rxBuf.length === 0 ? Buffer.from(data) : Buffer.concat([this.rxBuf, data])
    for (;;) {
      let parsed: ParsedMessage | null
      try {
        parsed = tryParseMessage(this.rxBuf)
      } catch (e) {
        this.failAll(e as Error)
        this.sock.destroy()
        return
      }
      if (!parsed) return
      const { msg, size } = parsed
      this.rxBuf = this.rxBuf.subarray(size)
      this.dispatch(msg)
    }
  }

  private dispatch(msg: Message): void {
    if (msg.type === MSG_METHOD_RETURN) {
      const p = msg.replySerial ? this.pending.get(msg.replySerial) : undefined
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.replySerial!)
        p.resolve(msg.body)
      }
      return
    }
    if (msg.type === MSG_ERROR) {
      const p = msg.replySerial ? this.pending.get(msg.replySerial) : undefined
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.replySerial!)
        // el nombre del error viaja en la cabecera; el texto, en el cuerpo.
        // Incluirlo en el mensaje lo hace visible en logs y asserts.
        const name = msg.errorName ?? "org.freedesktop.DBus.Error.Failed"
        p.reject(new DBusError(name, `[${name}] ${String(msg.body[0] ?? "")}`))
      }
      return
    }
    if (msg.type === MSG_SIGNAL) {
      for (const cb of this.signalHandlers) {
        try {
          cb({ path: msg.path!, iface: msg.iface!, member: msg.member!, sender: msg.sender, args: msg.body })
        } catch {
          // un handler roto no puede tumbar la bandeja
        }
      }
      return
    }
    if (msg.type === MSG_METHOD_CALL) {
      void this.handleCall(msg)
    }
  }

  private async handleCall(msg: Message): Promise<void> {
    const sender = msg.sender
    const replySerial = msg.serial
    const path = msg.path!
    const reply = (type: number, errorName: string | undefined, signature: string, body: unknown[]): void => {
      if (msg.flags & FLAG_NO_REPLY) return
      const serial = ++this.serial
      const out = encodeMessage(
        {
          type,
          flags: 0,
          serial,
          replySerial,
          destination: sender,
          errorName,
          signature: signature || undefined,
          body,
        },
        serial,
      )
      this.sock.write(out)
    }
    const replyOk = (sig: string, body: unknown[]) => reply(MSG_METHOD_RETURN, undefined, sig, body)
    const replyErr = (name: string, text: string) => reply(MSG_ERROR, name, "s", [text])

    try {
      const obj = this.objects.get(path)
      if (!obj) {
        replyErr("org.freedesktop.DBus.Error.UnknownObject", `no hay objeto en la ruta ${path}`)
        return
      }

      // --- interfaces estándar ---
      if (msg.iface === "org.freedesktop.DBus.Peer") {
        if (msg.member === "Ping") return replyOk("", [])
        if (msg.member === "GetMachineId") return replyOk("s", [machineId()])
        return replyErr("org.freedesktop.DBus.Error.UnknownMethod", `método desconocido: ${msg.member}`)
      }
      if (msg.iface === "org.freedesktop.DBus.Introspectable") {
        if (msg.member === "Introspect") return replyOk("s", [introspectXml(obj)])
        return replyErr("org.freedesktop.DBus.Error.UnknownMethod", `método desconocido: ${msg.member}`)
      }
      if (msg.iface === "org.freedesktop.DBus.Properties") {
        const targetIface = String(msg.body[0])
        const def = obj.interfaces[targetIface]
        if (!def) {
          return replyErr("org.freedesktop.DBus.Error.UnknownInterface", `interfaz desconocida: ${targetIface}`)
        }
        if (msg.member === "Get") {
          const name = String(msg.body[1])
          const p = def.properties?.[name]
          if (!p) return replyErr("org.freedesktop.DBus.Error.InvalidArgs", `propiedad desconocida: ${name}`)
          return replyOk("v", [new Variant(p.sig, p.get())])
        }
        if (msg.member === "GetAll") {
          const entries: Array<[string, Variant]> = Object.entries(def.properties ?? {}).map(([k, p]) => [
            k,
            new Variant(p.sig, p.get()),
          ])
          return replyOk("a{sv}", [entries])
        }
        if (msg.member === "Set") {
          return replyErr("org.freedesktop.DBus.Error.PropertyReadOnly", "propiedades de solo lectura")
        }
        return replyErr("org.freedesktop.DBus.Error.UnknownMethod", `método desconocido: ${msg.member}`)
      }

      // --- interfaz exportada por el usuario ---
      const def = obj.interfaces[msg.iface!]
      if (!def) {
        return replyErr("org.freedesktop.DBus.Error.UnknownInterface", `interfaz desconocida: ${msg.iface}`)
      }
      const method = def.methods[msg.member!]
      if (!method) {
        return replyErr(
          "org.freedesktop.DBus.Error.UnknownMethod",
          `método desconocido: ${msg.iface}.${msg.member} (objeto ${path})`,
        )
      }
      const ret = await method.handler(msg.body)
      return replyOk(method.out ?? "", ret)
    } catch (e) {
      const err = e as DBusError
      if (err instanceof DBusError) {
        return replyErr(err.errorName, err.message)
      }
      return replyErr("org.freedesktop.DBus.Error.Failed", String((e as Error)?.message ?? e))
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  close(): void {
    this.failAll(new DBusError("org.freedesktop.DBus.Error.Disconnected", "conexión cerrada localmente"))
    this.sock.destroy()
  }
}

function guessSig(v: unknown): string {
  if (typeof v === "string") return "s"
  if (typeof v === "number") return "i"
  if (typeof v === "boolean") return "b"
  return "v"
}

let cachedMachineId: string | undefined
function machineId(): string {
  if (cachedMachineId) return cachedMachineId
  try {
    cachedMachineId = readFileSync("/etc/machine-id", "utf8").trim()
  } catch {
    cachedMachineId = "00000000000000000000000000000000"
  }
  return cachedMachineId
}

function introspectXml(obj: ExportedObject): string {
  let xml = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n<node>\n`
  for (const [name, def] of Object.entries(obj.interfaces)) {
    xml += `  <interface name="${name}">\n`
    for (const [mName, m] of Object.entries(def.methods)) {
      xml += `    <method name="${mName}">\n`
      if (m.in) for (const node of parseSignature(m.in)) xml += `      <arg direction="in" type="${renderSignature(node)}"/>\n`
      if (m.out) for (const node of parseSignature(m.out)) xml += `      <arg direction="out" type="${renderSignature(node)}"/>\n`
      xml += `    </method>\n`
    }
    for (const [sName, s] of Object.entries(def.signals ?? {})) {
      xml += `    <signal name="${sName}">\n`
      if (s.sig) for (const node of parseSignature(s.sig)) xml += `      <arg type="${renderSignature(node)}"/>\n`
      xml += `    </signal>\n`
    }
    for (const [pName, p] of Object.entries(def.properties ?? {})) {
      xml += `    <property name="${pName}" type="${p.sig}" access="read"/>\n`
    }
    xml += `  </interface>\n`
  }
  xml += `</node>\n`
  return xml
}
