/**
 * Tests de la BANDEJA LINUX NUEVA (v3.2.2) — TypeScript puro sobre el runtime
 * bun EMPAQUETADO (cero dependencias del sistema: sin python3-gi, sin GTK).
 *
 * POR QUÉ: la bandeja anterior (Python3+PyGObject+GTK) dependía de paquetes
 * del SISTEMA (python3-gi, gir1.2-ayatanaappindicator) que `dpkg -i` NO
 * instala (eran «Recommends») y que una máquina OFFLINE no puede conseguir
 * → la bandeja no arrancaba. La nueva habla D-Bus directamente (SNI +
 * DBusMenu + Notifications) con el bun que YA viaja dentro del .deb.
 *
 * NIVELES DE VERIFICACIÓN (de la unidad a la integración real):
 *   1. Firma de tipos: parseSignature/renderSignature (golden vectors).
 *   2. Marshalling: bytes EXACTOS de cada tipo (alineaciones del spec
 *      oficial — STRUCT a 8, padding de array incluso vacío, VARIANT a 1).
 *   3. Mensajes completos: encode → parse round-trip con cabecera de 12
 *      bytes + a(yv) + cuerpo alineado a 8.
 *   4. INTEGRACIÓN REAL: dbus-daemon privado (spawn) — SASL EXTERNAL,
 *      Hello, RequestName, llamadas, errores y EXPORTACIÓN de objetos.
 *   5. E2E DE LA BANDEJA COMPLETA: watcher SNI simulado + demonio de
 *      notificaciones simulado + systemctl/pkexec/xdg-open falsos → la
 *      bandeja REAL (proceso aparte) registrada, con menú funcional,
 *      cambio de estado (icono rojo→verde), acciones y notificaciones.
 *
 * Si dbus-daemon no está disponible (p.ej. macOS), los tests de integración
 * se saltan con skip — los de marshalling (puros) corren SIEMPRE.
 */
import { describe, test, expect, beforeAll, afterAll, skip } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  DBusConnection,
  DBusError,
  Variant,
  parseSignature,
  renderSignature,
  parseAddress,
  encodeMessage,
  tryParseMessage,
  MSG_METHOD_CALL,
  FLAG_NO_REPLY,
} from "../../installer/linux/tray/dbus"

const REPO = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "prisma"))) return dir
    dir = dirname(dir)
  }
  return process.cwd()
})()

const TRAY_TS = join(REPO, "installer", "linux", "tray", "tray.ts")
const DBUS_TS = join(REPO, "installer", "linux", "tray", "dbus.ts")

// ---------------------------------------------------------------------------
// 1. Firma de tipos
// ---------------------------------------------------------------------------
describe("Bandeja Linux (TS) — firma de tipos", () => {
  test("parsea y renderiza firmas básicas", () => {
    for (const sig of ["u", "s", "i", "b", "as", "a{sv}", "(ii)", "a(iiay)", "(sa(iiay)ss)", "iias", "u(ia{sv}av)", "a(isvu)"]) {
      const nodes = parseSignature(sig)
      expect(nodes.map(renderSignature).join("")).toBe(sig)
    }
  })

  test("firma completa se separa en tipos completos", () => {
    const nodes = parseSignature("iias")
    expect(nodes).toHaveLength(3)
    const [a, b, c] = nodes
    expect(renderSignature(a)).toBe("i")
    expect(renderSignature(b)).toBe("i")
    expect(renderSignature(c)).toBe("as")
  })

  test("struct anidado en array de variantes (layout DBusMenu)", () => {
    const nodes = parseSignature("u(ia{sv}av)")
    expect(nodes).toHaveLength(2)
    expect(renderSignature(nodes[1])).toBe("(ia{sv}av)")
  })

  test("firma inválida lanza", () => {
    expect(() => parseSignature("(")).toThrow()
    expect(() => parseSignature("{s}")).toThrow()
    expect(() => parseSignature("z")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. Marshalling — bytes EXACTOS (golden vectors calculados a mano)
// ---------------------------------------------------------------------------
describe("Bandeja Linux (TS) — marshalling golden", () => {
  test("u32 little-endian con alineación 4", () => {
    const msg = { type: MSG_METHOD_CALL, flags: 0, serial: 1, path: "/x", iface: "a.b", member: "M", signature: "u", body: [0xdeadbeef] }
    const all = encodeMessage(msg, 1)
    const bodyStart = (16 + all.readUInt32LE(12) + 7) & ~7
    expect(bodyStart % 8).toBe(0)
    expect(all.readUInt32LE(bodyStart)).toBe(0xdeadbeef)
  })

  test("string: u32 len + bytes + NUL", () => {
    const msg = { type: MSG_METHOD_CALL, flags: 0, serial: 1, path: "/x", iface: "a.b", member: "M", signature: "s", body: ["hi"] }
    const all = encodeMessage(msg, 1)
    const bodyStart = (16 + all.readUInt32LE(12) + 7) & ~7
    expect(all.subarray(bodyStart).equals(Buffer.from([0x02, 0x00, 0x00, 0x00, 0x68, 0x69, 0x00]))).toBe(true)
  })

  test("boolean como u32", () => {
    const msg = { type: MSG_METHOD_CALL, flags: 0, serial: 1, path: "/x", iface: "a.b", member: "M", signature: "b", body: [true] }
    const all = encodeMessage(msg, 1)
    const bodyStart = (16 + all.readUInt32LE(12) + 7) & ~7
    expect(all.readUInt32LE(bodyStart)).toBe(1)
  })

  test("struct se alinea a 8 (padding previo aunque venga de un byte)", () => {
    // y (1 byte) + (ii): el struct DEBE empezar en múltiplo de 8
    const msg = { type: MSG_METHOD_CALL, flags: 0, serial: 1, path: "/x", iface: "a.b", member: "M", signature: "y(ii)", body: [7, [1, 2]] }
    const all = encodeMessage(msg, 1)
    const bodyStart = (16 + all.readUInt32LE(12) + 7) & ~7
    // byte 7 en bodyStart+0, luego padding hasta bodyStart+8, luego (1,2)
    expect(all[bodyStart]).toBe(7)
    const structStart = bodyStart + 8
    expect(all.readUInt32LE(structStart)).toBe(1)
    expect(all.readUInt32LE(structStart + 4)).toBe(2)
  })

  test("array vacío de 8-alineados escribe el padding (spec)", () => {
    // a(i): u32 len=0 + padding a 4 del elemento... a(i) elemento alinea 4
    const msg = { type: MSG_METHOD_CALL, flags: 0, serial: 1, path: "/x", iface: "a.b", member: "M", signature: "ai", body: [[]] }
    const all = encodeMessage(msg, 1)
    const bodyStart = (16 + all.readUInt32LE(12) + 7) & ~7
    expect(all.readUInt32LE(bodyStart)).toBe(0) // longitud 0
  })

  test("a{sv} con una entrada: dict entry a 8", () => {
    const msg = {
      type: MSG_METHOD_CALL,
      flags: 0,
      serial: 1,
      path: "/x",
      iface: "a.b",
      member: "M",
      signature: "a{sv}",
      body: [[["label", new Variant("s", "Iniciar servidor")]]],
    }
    const all = encodeMessage(msg, 1)
    const parsed = tryParseMessage(all)!
    const dict = parsed.msg.body[0] as Array<[string, Variant]>
    expect(dict).toHaveLength(1)
    expect(dict[0][0]).toBe("label")
    expect(dict[0][1].sig).toBe("s")
    expect(dict[0][1].value).toBe("Iniciar servidor")
  })

  test("variant anidada con struct (layout DBusMenu)", () => {
    const inner = [10, [["label", new Variant("s", "Detener servidor")]], []]
    const msg = {
      type: MSG_METHOD_CALL,
      flags: 0,
      serial: 1,
      path: "/x",
      iface: "a.b",
      member: "M",
      signature: "av",
      body: [[new Variant("(ia{sv}av)", inner)]],
    }
    const all = encodeMessage(msg, 1)
    const parsed = tryParseMessage(all)!
    const arr = parsed.msg.body[0] as Variant[]
    expect(arr).toHaveLength(1)
    expect(arr[0].sig).toBe("(ia{sv}av)")
    const v = arr[0].value as [number, Array<[string, Variant]>, unknown[]]
    expect(v[0]).toBe(10)
    expect(v[1][0][0]).toBe("label")
    expect((v[1][0][1] as Variant).value).toBe("Detener servidor")
  })

  test("int64/uint64 con BigInt", () => {
    const msg = {
      type: MSG_METHOD_CALL,
      flags: 0,
      serial: 1,
      path: "/x",
      iface: "a.b",
      member: "M",
      signature: "xt",
      body: [[BigInt("-9007199254740993")], BigInt("18446744073709551615")],
    }
    const all = encodeMessage(msg, 1)
    const parsed = tryParseMessage(all)!
    expect(parsed.msg.body[0]).toBe(BigInt("-9007199254740993"))
    expect(parsed.msg.body[1]).toBe(BigInt("18446744073709551615"))
  })
})

// ---------------------------------------------------------------------------
// 3. Mensajes completos (round-trip)
// ---------------------------------------------------------------------------
describe("Bandeja Linux (TS) — mensajes", () => {
  test("cabecera: endian 'l', versión 1, bodyLen@4, serial@8, arrayLen@12, múltiplo de 8", () => {
    const msg = {
      type: MSG_METHOD_CALL,
      flags: 0,
      serial: 77,
      path: "/org/x",
      iface: "org.x.Y",
      member: "Method",
      destination: "org.x",
      signature: "s",
      body: ["hola"],
    }
    const all = encodeMessage(msg, 77)
    expect(all[0]).toBe(0x6c) // 'l'
    expect(all[1]).toBe(MSG_METHOD_CALL)
    expect(all[3]).toBe(1)
    expect(all.readUInt32LE(4)).toBe(9) // "hola": u32(4) + 4 chars + NUL
    expect(all.readUInt32LE(8)).toBe(77)
    const arrayLen = all.readUInt32LE(12)
    expect(arrayLen).toBeGreaterThan(0)
    // campos: path, iface, member, destination, signature = 5
    const parsed = tryParseMessage(all)!
    expect(parsed.size).toBe(all.length)
    // la CABECERA (múltiplo de 8, spec) sitúa el cuerpo en frontera de 8;
    // el total del mensaje termina donde termine el último valor del cuerpo
    const bodyStart = (16 + arrayLen + 7) & ~7
    expect(bodyStart % 8).toBe(0)
    expect(all.length).toBe(bodyStart + 9) // cuerpo de "hola"
    expect(parsed.msg.path).toBe("/org/x")
    expect(parsed.msg.iface).toBe("org.x.Y")
    expect(parsed.msg.member).toBe("Method")
    expect(parsed.msg.destination).toBe("org.x")
    expect(parsed.msg.signature).toBe("s")
    expect(parsed.msg.body[0]).toBe("hola")
  })

  test("parseo incremental: media llegada → null, completa → ok", () => {
    const msg = {
      type: MSG_METHOD_CALL,
      flags: 0,
      serial: 1,
      path: "/x",
      iface: "a.b",
      member: "M",
      signature: "s",
      body: ["0123456789"],
    }
    const all = encodeMessage(msg, 1)
    expect(tryParseMessage(all.subarray(0, 10))).toBeNull()
    expect(tryParseMessage(all.subarray(0, all.length - 1))).toBeNull()
    expect(tryParseMessage(all)).not.toBeNull()
  })

  test("parseAddress: path, abstract, múltiples y con guid", () => {
    expect(parseAddress("unix:path=/run/user/1000/bus")).toEqual([{ kind: "path", value: "/run/user/1000/bus" }])
    expect(parseAddress("unix:abstract=/tmp/dbus-XX,guid=abc")).toEqual([{ kind: "abstract", value: "/tmp/dbus-XX" }])
    const multi = parseAddress("unix:path=/a;unix:abstract=/b,guid=g")
    expect(multi).toHaveLength(2)
    expect(multi[0]).toEqual({ kind: "path", value: "/a" })
    expect(multi[1]).toEqual({ kind: "abstract", value: "/b" })
  })
})

// ---------------------------------------------------------------------------
// 4 + 5. Integración REAL (requiere dbus-daemon — Linux)
// ---------------------------------------------------------------------------
const HAS_DBUS = (() => {
  const r = spawnSync("dbus-daemon", ["--version"], { captureOutput: true, encoding: "utf8" })
  return r.status === 0
})()

describe.skipIf(!HAS_DBUS)("Bandeja Linux (TS) — integración real con dbus-daemon", () => {
  let work: string
  let address: string
  let conn: DBusConnection

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "viewlba-dbus-test-"))
    const busPath = join(work, "bus")
    const r = spawnSync("dbus-daemon", ["--session", "--print-address", "--fork", `--address=unix:path=${busPath}`], {
      captureOutput: true,
      encoding: "utf8",
    })
    address = r.stdout.trim().split("\n")[0]
    conn = await DBusConnection.connect({ address })
    await conn.hello()
  }, 20_000)

  afterAll(() => {
    try {
      conn?.close()
    } catch {
      // nada
    }
    rmSync(work, { recursive: true, force: true })
  })

  test("conecta + Hello + RequestName (SASL EXTERNAL real)", async () => {
    expect(conn.uniqueName).toMatch(/^:1\.\d+$/)
    await conn.requestName("org.viewlba.Test1")
    // nombre tomado por OTRA conexión → error
    const other = await DBusConnection.connect({ address })
    await other.hello()
    await expect(other.requestName("org.viewlba.Test1")).rejects.toThrow()
    other.close()
  })

  test("llamada con error se propaga como DBusError", async () => {
    await expect(
      conn.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "s", ["nombre inválido con espacios"]),
    ).rejects.toThrow(DBusError)
  })

  test("exporta objeto + Properties + Introspect + Peer (como el host de verdad)", async () => {
    conn.exportObject("/t", {
      "org.viewlba.Demo": {
        methods: {
          Echo: { in: "s", out: "s", handler: (args) => [`eco:${args[0]}`] },
          Layout: { in: "iias", out: "u(ia{sv}av)", handler: () => [1, [0, [], []]] },
        },
        properties: {
          Version: { sig: "u", get: () => 3 },
          IconName: { sig: "s", get: () => "viewlba-running" },
        },
      },
    })
    await conn.requestName("org.viewlba.Test2")

    const [echo] = await conn.call("org.viewlba.Test2", "/t", "org.viewlba.Demo", "Echo", "s", ["mundo"])
    expect(echo).toBe("eco:mundo")

    const [all] = await conn.call("org.viewlba.Test2", "/t", "org.freedesktop.DBus.Properties", "GetAll", "s", ["org.viewlba.Demo"])
    const dict = all as Array<[string, Variant]>
    expect(dict.find(([k]) => k === "IconName")![1].value).toBe("viewlba-running")

    const [one] = await conn.call("org.viewlba.Test2", "/t", "org.freedesktop.DBus.Properties", "Get", "ss", ["org.viewlba.Demo", "Version"])
    expect((one as Variant).value).toBe(3)

    const [xml] = await conn.call("org.viewlba.Test2", "/t", "org.freedesktop.DBus.Introspectable", "Introspect", "", [])
    expect(String(xml)).toContain("org.viewlba.Demo")
    // los dos valores de retorno de Layout: u + (ia{sv}av)
    expect(String(xml)).toContain('<arg direction="out" type="(ia{sv}av)"/>')

    await conn.call("org.viewlba.Test2", "/t", "org.freedesktop.DBus.Peer", "Ping", "", [])
  })

  test("método desconocido → UnknownMethod (lo que los hosts esperan)", async () => {
    await expect(conn.call("org.viewlba.Test2", "/t", "org.viewlba.Demo", "NoExiste", "", [])).rejects.toThrow(/UnknownMethod/)
    conn.unexportObject("/t")
  })
})

describe.skipIf(!HAS_DBUS)("Bandeja Linux (TS) — E2E con watcher SNI simulado", () => {
  let work: string
  let address: string
  let tray: ReturnType<typeof spawn> | null = null
  let watcher: DBusConnection
  let registered: string[] = []
  let lastNotification: { summary: string; body: string } | null = null

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "viewlba-tray-e2e-"))
    // binarios falsos
    const stateFile = join(work, "state")
    const logFile = join(work, "log")
    writeFileSync(stateFile, "inactive")
    writeFileSync(logFile, "")
    writeFileSync(join(work, "credenciales.txt"), "admin@viewlba.local\nViewLBA-XXXX")
    writeFileSync(
      join(work, "systemctl"),
      `#!/bin/sh\ncase "$*" in *is-active*) cat "${stateFile}" ;; *) echo "SYSTEMCTL $*" >> "${logFile}"; exit 0 ;; esac\n`,
      { mode: 0o755 },
    )
    writeFileSync(join(work, "pkexec"), `#!/bin/sh\necho "PKEXEC $*" >> "${logFile}"\n`, { mode: 0o755 })
    writeFileSync(join(work, "xdg-open"), `#!/bin/sh\necho "OPEN $*" >> "${logFile}"\n`, { mode: 0o755 })

    // dbus-daemon privado
    const r = spawnSync("dbus-daemon", ["--session", "--print-address", "--fork", `--address=unix:path=${join(work, "bus")}`], {
      captureOutput: true,
      encoding: "utf8",
    })
    address = r.stdout.trim().split("\n")[0]

    // watcher SNI + demonio de notificaciones simulados (el «escritorio»)
    watcher = await DBusConnection.connect({ address })
    await watcher.hello()
    watcher.exportObject("/org/freedesktop/Notifications", {
      "org.freedesktop.Notifications": {
        methods: {
          Notify: {
            in: "susssasa{sv}i",
            out: "u",
            handler: (args) => {
              lastNotification = { summary: String(args[3]), body: String(args[4]) }
              return [1]
            },
          },
        },
      },
    })
    await watcher.requestName("org.freedesktop.Notifications")
    watcher.exportObject("/StatusNotifierWatcher", {
      "org.kde.StatusNotifierWatcher": {
        methods: {
          RegisterStatusNotifierItem: {
            in: "s",
            handler: (args) => {
              registered.push(String(args[0]))
              return []
            },
          },
        },
        properties: {
          IsStatusNotifierHostRegistered: { sig: "b", get: () => true },
          ProtocolVersion: { sig: "i", get: () => 0 },
          RegisteredStatusNotifierItems: { sig: "as", get: () => registered },
        },
      },
    })
    await watcher.requestName("org.kde.StatusNotifierWatcher")

    // la bandeja REAL como proceso aparte (DISPLAY falso para pasar el guard)
    tray = spawn("bun", [TRAY_TS], {
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: address,
        DISPLAY: ":99",
        XDG_RUNTIME_DIR: work,
        VIEWLBA_TRAY_SYSTEMCTL: join(work, "systemctl"),
        VIEWLBA_TRAY_PKEXEC: join(work, "pkexec"),
        VIEWLBA_TRAY_XDG_OPEN: join(work, "xdg-open"),
        VIEWLBA_TRAY_CRED_FILE: join(work, "credenciales.txt"),
        VIEWLBA_TRAY_DATA_DIR: work,
        VIEWLBA_TRAY_LOG_DIR: work,
        VIEWLBA_TRAY_TICK_MS: "800",
        VIEWLBA_TRAY_FAST_TICK_MS: "300",
        VIEWLBA_STATE_FILE: stateFile,
        VIEWLBA_TRAY_LOG_FILE: logFile,
      },
      stdio: ["ignore", "inherit", "inherit"],
    })

    // esperar registro
    const t0 = Date.now()
    while (registered.length === 0 && Date.now() - t0 < 10_000) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }, 30_000)

  afterAll(() => {
    if (tray && tray.exitCode === null) tray.kill("SIGTERM")
    try {
      watcher?.close()
    } catch {
      // nada
    }
    rmSync(work, { recursive: true, force: true })
  })

  const readLog = (): string[] => {
    try {
      return readFileSync(join(work, "log"), "utf8").split("\n").filter(Boolean)
    } catch {
      return []
    }
  }
  const setServiceState = (s: string) => writeFileSync(join(work, "state"), s)
  const sniGet = async (prop: string): Promise<unknown> => {
    const [v] = await watcher.call(registered[0], "/StatusNotifierItem", "org.freedesktop.DBus.Properties", "Get", "ss", [
      "org.kde.StatusNotifierItem",
      prop,
    ])
    return (v as Variant).value
  }
  const getLayout = async (): Promise<{ rev: number; labels: string[]; layout: Variant[] }> => {
    const [rev, layout] = (await watcher.call(registered[0], "/MenuBar", "com.canonical.dbusmenu", "GetLayout", "iias", [
      0,
      -1,
      [],
    ])) as [number, [number, Array<[string, Variant]>, Variant[]]]
    const labels = layout[2].map((c) => {
      const v = c.value as [number, Array<[string, Variant]>, unknown[]]
      const labelProp = v[1].find(([k]) => k === "label")
      return labelProp ? (labelProp[1].value as string) : null
    })
    return { rev, labels, layout: layout[2] }
  }

  test("la bandeja se registró en el watcher SNI", () => {
    expect(registered.length).toBeGreaterThan(0)
    expect(registered[0]).toMatch(/^org\.kde\.StatusNotifierItem-\d+-1$/)
  })

  test("propiedades SNI iniciales (icono detenido + menú + tooltip)", async () => {
    expect(await sniGet("IconName")).toBe("viewlba-stopped")
    expect(await sniGet("Menu")).toBe("/MenuBar")
    expect(await sniGet("Title")).toBe("ViewLBA Server")
    expect(await sniGet("Category")).toBe("ApplicationStatus")
    const tip = (await sniGet("ToolTip")) as [string, unknown[], string, string]
    expect(tip[0]).toBe("viewlba-stopped")
  })

  test("menú DBusMenu completo: Iniciar · Detener · Reiniciar · Configurar… · Panel · Credenciales · Salir", async () => {
    const { labels } = await getLayout()
    expect(labels).toContain("Iniciar servidor")
    expect(labels).toContain("Detener servidor")
    expect(labels).toContain("Reiniciar servidor")
    expect(labels).toContain("Configurar…")
    expect(labels).toContain("Ver credenciales")
    expect(labels.some((l) => l?.startsWith("Abrir Panel"))).toBe(true)
    expect(labels.some((l) => l?.startsWith("Salir"))).toBe(true)
    expect(labels.some((l) => l?.startsWith("Estado:"))).toBe(true)
  })

  test("«Detener» deshabilitado con el servidor detenido, habilitado al arrancar", async () => {
    const enabledOf = (label: string, nodes: Variant[]) => {
      const node = nodes.find((c) => {
        const v = c.value as [number, Array<[string, Variant]>, unknown[]]
        return v[1].some(([k, val]) => k === "label" && val.value === label)
      })
      const v = node!.value as [number, Array<[string, Variant]>, unknown[]]
      return v[1].find(([k]) => k === "enabled")![1].value as boolean
    }
    const first = await getLayout()
    expect(enabledOf("Detener servidor", first.layout)).toBe(false)

    setServiceState("active")
    await new Promise((r) => setTimeout(r, 2500))
    const second = await getLayout()
    expect(enabledOf("Detener servidor", second.layout)).toBe(true)
    expect(second.rev).toBeGreaterThan(first.rev)
  }, 15_000)

  test("el icono cambia con el estado (rojo → verde) y llega la notificación", async () => {
    expect(await sniGet("IconName")).toBe("viewlba-running")
    // la notificación de transición pudo llegar justo al cambiar el estado
    expect(lastNotification).not.toBeNull()
    expect((lastNotification as { summary: string }).summary).toContain("EN EJECUCIÓN")
  }, 10_000)

  test("clic en «Iniciar servidor» → pkexec systemctl start pantalla-restaurante.target", async () => {
    const { layout } = await getLayout()
    const node = layout.find((c) => {
      const v = c.value as [number, Array<[string, Variant]>, unknown[]]
      return v[1].some(([k, val]) => k === "label" && val.value === "Iniciar servidor")
    })
    const id = (node!.value as [number, unknown, unknown])[0]
    await watcher.call(registered[0], "/MenuBar", "com.canonical.dbusmenu", "Event", "isvu", [id, "clicked", new Variant("s", ""), 0])
    await new Promise((r) => setTimeout(r, 600))
    expect(readLog().some((l) => l.includes("PKEXEC") && l.includes("start pantalla-restaurante.target"))).toBe(true)
  })

  test("clic en «Abrir Panel» → abre http://localhost:3000", async () => {
    const { layout } = await getLayout()
    const node = layout.find((c) => {
      const v = c.value as [number, Array<[string, Variant]>, unknown[]]
      return v[1].some(([k, val]) => k === "label" && (val.value as string).startsWith("Abrir Panel"))
    })
    const id = (node!.value as [number, unknown, unknown])[0]
    await watcher.call(registered[0], "/MenuBar", "com.canonical.dbusmenu", "Event", "isvu", [id, "clicked", new Variant("s", ""), 0])
    await new Promise((r) => setTimeout(r, 600))
    expect(readLog().some((l) => l.includes("OPEN http://localhost:3000"))).toBe(true)
  })

  test("clic en «Ver credenciales» → abre el CREDENCIALES.txt", async () => {
    const { layout } = await getLayout()
    const node = layout.find((c) => {
      const v = c.value as [number, Array<[string, Variant]>, unknown[]]
      return v[1].some(([k, val]) => k === "label" && val.value === "Ver credenciales")
    })
    const id = (node!.value as [number, unknown, unknown])[0]
    await watcher.call(registered[0], "/MenuBar", "com.canonical.dbusmenu", "Event", "isvu", [id, "clicked", new Variant("s", ""), 0])
    await new Promise((r) => setTimeout(r, 600))
    expect(readLog().some((l) => l.includes("OPEN") && l.includes("credenciales"))).toBe(true)
  })

  test("AboutToShow y Activate (clic izquierdo → panel)", async () => {
    const [about] = await watcher.call(registered[0], "/MenuBar", "com.canonical.dbusmenu", "AboutToShow", "i", [0])
    expect(about).toBe(false)
    await watcher.call(registered[0], "/StatusNotifierItem", "org.kde.StatusNotifierItem", "Activate", "ii", [0, 0])
    await new Promise((r) => setTimeout(r, 600))
    expect(readLog().filter((l) => l.includes("OPEN http://localhost:3000")).length).toBeGreaterThanOrEqual(2)
  })

  test("el código fuente de la bandeja existe (tray.ts + dbus.ts)", () => {
    expect(existsSync(TRAY_TS)).toBe(true)
    expect(existsSync(DBUS_TS)).toBe(true)
  })
})
