/**
 * Disponibilidad de puertos TCP — con net.Server (listen de prueba), sin
 * comandos externos (lsof/ss/netstat son específicos de SO).
 */
import { createServer } from "node:net"

/**
 * ¿El puerto está libre en la interfaz indicada?
 * Cierra el servidor de prueba inmediatamente (no deja handles colgados).
 */
export function portAvailable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      srv.close()
      resolve(ok)
    }
    srv.once("error", () => done(false))
    srv.once("listening", () => done(true))
    const t = setTimeout(() => done(false), timeoutMs)
    t.unref?.()
    srv.listen(port, host)
  })
}

/** Puertos que el installer debe comprobar antes de instalar. */
export interface PortSpec {
  id: string
  label: string
  port: number
  /** Interfaces donde debe estar libre (LAN + localhost para servicios LAN). */
  hosts: string[]
}

export function requiredPorts(web: number, realtime: number, rtmp: number, flv: number): PortSpec[] {
  return [
    { id: "web", label: `App web :${web}`, port: web, hosts: ["0.0.0.0"] },
    { id: "realtime", label: `Realtime (socket.io) :${realtime}`, port: realtime, hosts: ["0.0.0.0"] },
    { id: "rtmp", label: `RTMP ingest :${rtmp}`, port: rtmp, hosts: ["0.0.0.0"] },
    { id: "flv", label: `HTTP-FLV :${flv} (solo localhost)`, port: flv, hosts: ["127.0.0.1"] },
  ]
}

/**
 * Comprueba todos los puertos requeridos. `busyOk` = puertos ocupados por
 * los PROPIOS servicios de una instalación previa (modo update/repair) —
 * en ese caso no es bloqueante.
 */
export async function checkPorts(
  specs: PortSpec[],
  busyOk: Set<number>
): Promise<Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail?: string; hint?: string }>> {
  const results: Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail?: string; hint?: string }> = []
  for (const spec of specs) {
    const free: boolean[] = []
    for (const host of spec.hosts) {
      free.push(await portAvailable(host, spec.port))
    }
    const anyBusy = free.some((f) => !f)
    if (!anyBusy) {
      results.push({ id: spec.id, label: spec.label, status: "pass" })
    } else if (busyOk.has(spec.port)) {
      results.push({
        id: spec.id,
        label: spec.label,
        status: "warn",
        detail: "ocupado por los servicios de ViewLBA ya instalados (modo actualizar/reparar)",
      })
    } else {
      results.push({
        id: spec.id,
        label: spec.label,
        status: "fail",
        detail: "puerto ocupado por otro proceso",
        hint: `Libera el puerto ${spec.port} o elige otro puerto en la configuración`,
      })
    }
  }
  return results
}
