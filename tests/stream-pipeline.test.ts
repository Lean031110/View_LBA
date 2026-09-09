/**
 * FASE 23 (misión) — STREAM E2E REAL: pipeline completo con bytes de verdad.
 *
 * Cadena probada (sin simulaciones):
 *   ffmpeg (publisher RTMP — "el OBS de CI")
 *        ↓ rtmp://127.0.0.1:1935/live/<clave>
 *   Node Media Server (stream-service)
 *        ↓ HTTP-FLV 127.0.0.1:8000
 *   PROXY /api/stream/live.flv (Next.js dev :3100)
 *        ↓ bytes FLV leídos y validados
 *
 * Comprueba (requisito de la misión):
 *   · stream live        → :8100/status y /api/stream/status → live=true
 *   · reproducción       → 200 + video/x-flv + cabecera "FLV" + CONTINUIDAD
 *                          (los bytes siguen fluyendo durante la lectura)
 *   · reconexión         → corte breve del publisher (< gracia de NMS) → live NO baja
 *   · caída              → SIGINT a ffmpeg → live=false tras la gracia
 *                          (NMS v4 PUBLISH_GRACE_MS=30s + 2.5s del servicio)
 *   · recuperación       → nuevo publisher → live=true + FLV fluye de nuevo
 *
 * Autocontenido: crea DB temporal, spawn del stream-service y de next dev.
 * SKIP VISIBLE (nunca silencioso) si: no hay ffmpeg, o los puertos del
 * stream-service están ocupados (p. ej. E2E corriendo — comparten .next).
 */
import { describe, it, expect, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { Database } from "bun:sqlite"

const ROOT = resolve(import.meta.dir, "..")
const APP_PORT = 3100
const APP = `http://127.0.0.1:${APP_PORT}`
const CONTROL = "http://127.0.0.1:8100"
const RTMP = "rtmp://127.0.0.1:1935/live"

const AUTH_SECRET = "rt-test-secret-0123456789abcdef0123456789"
const REALTIME_TOKEN = "rt-test-internal-token-0123456789abcdef"
const STREAM_KEY = "pipeline-test-key-0123456789abcdef"

let streamProc: ChildProcess | null = null
let appProc: ChildProcess | null = null
let tmpDir = ""
let dbPath = ""

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (v: T) => boolean, ms: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    let v: T
    try {
      v = await fn()
    } catch {
      v = undefined as unknown as T
    }
    if (predicate(v)) return v
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout (${ms}ms)`)
    await wait(300)
  }
}

/** Puerto TCP libre? (probe real, no cache de DNS) */
async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) })
    return false // algo responde → ocupado
  } catch (e) {
    const msg = String((e as Error)?.cause ?? (e as Error).message ?? "")
    // ConnectionRefused/DNS → libre; timeout abort → ocupado (algo escucha lento)
    return /refused|ECONN|ENOTFOUND|reset/i.test(msg) || !msg.includes("aborted")
  }
}

function setupDb() {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE Settings (
      id TEXT PRIMARY KEY,
      streamSource TEXT DEFAULT 'local',
      streamEnabled BOOLEAN DEFAULT 1,
      streamKey TEXT,
      rtmpApp TEXT DEFAULT 'live'
    );
  `)
  db.run("INSERT INTO Settings (id, streamSource, streamEnabled, streamKey, rtmpApp) VALUES ('main', 'local', 1, ?, 'live')", [STREAM_KEY])
  db.close()
}

function startPublisher(): ChildProcess {
  return spawn(
    "ffmpeg",
    [
      "-loglevel", "error",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "96k",
      "-f", "flv",
      `${RTMP}/${STREAM_KEY}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
}

function stopPublisher(proc: ChildProcess | null): void {
  if (!proc || proc.exitCode !== null) return
  proc.kill("SIGINT")
  const t = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, 3000)
  t.unref?.()
}

async function svcStatus(): Promise<{ live: boolean; hasKey: boolean; publisherIp: string | null }> {
  const res = await fetch(`${CONTROL}/status`, { cache: "no-store" })
  return (await res.json()) as { live: boolean; hasKey: boolean; publisherIp: string | null }
}

async function publicStatus(): Promise<{ source: string; serverOk: boolean; live: boolean | null }> {
  const res = await fetch(`${APP}/api/stream/status`, { cache: "no-store" })
  return (await res.json()) as { source: string; serverOk: boolean; live: boolean | null }
}

interface FlvSample {
  status: number
  contentType: string
  firstBytes: string // primeros 3 bytes en ascii
  totalBytes: number // leídos durante la ventana
  chunks: number
}

/**
 * Lee el FLV por el PROXY durante `windowMs` y valida:
 * 200 + content-type FLV + cabecera "FLV" + flujo CONTINUO de bytes.
 */
async function sampleFlv(windowMs: number): Promise<FlvSample> {
  const res = await fetch(`${APP}/api/stream/live.flv`, { cache: "no-store" })
  if (!res.ok || !res.body) {
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", firstBytes: "", totalBytes: 0, chunks: 0 }
  }
  const reader = res.body.getReader()
  let total = 0
  let chunks = 0
  let first3 = ""
  const t0 = Date.now()
  try {
    for (;;) {
      const { value, done } = await Promise.race([
        reader.read(),
        wait(Math.max(200, windowMs)).then(() => ({ value: undefined, done: true as const })),
      ])
      if (value) {
        if (chunks === 0) first3 = Buffer.from(value).slice(0, 3).toString("ascii")
        total += value.length
        chunks += 1
      }
      if (done || Date.now() - t0 > windowMs) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", firstBytes: first3, totalBytes: total, chunks }
}

// ---- Disponibilidad del entorno (a NIVEL DE MÓDULO: la decisión de skip
// debe tomarse ANTES de registrar los describe — mismo patrón que
// integration/api.test.ts). SKIP VISIBLE, nunca silencioso. ----
let ffmpegAvailable = false
let portsAvailable = false
let skipReason = ""

if (Boolean(Bun.which("ffmpeg"))) {
  ffmpegAvailable = true
  // stream-service en sus puertos por defecto (1935/8000/8100 — el proxy de
  // la app los tiene hardcodeados). Si están ocupados (p. ej. E2E en marcha:
  // comparten .next) → skip VISIBLE en lugar de fallar.
  portsAvailable = (await portFree(8100)) && (await portFree(1935))
  if (!portsAvailable) skipReason = "puertos 1935/8100 ocupados (¿E2E/stream-service en marcha?) — test omitido"
} else {
  skipReason = "ffmpeg no disponible en este entorno (NOT VERIFIED en CI: comprobar imagen)"
}

const CAN_RUN = ffmpegAvailable && portsAvailable

if (CAN_RUN) {
  // ---- DB temporal (solo Settings: lo único que leen el servicio y el proxy) ----
  tmpDir = mkdtempSync(join(tmpdir(), "stream-e2e-"))
  dbPath = join(tmpDir, "test.db")
  setupDb()

  const env = `DATABASE_URL='file:${dbPath}' AUTH_SECRET='${AUTH_SECRET}' REALTIME_TOKEN='${REALTIME_TOKEN}'`

  // ---- stream-service (misma técnica del test de realtime: /bin/sh + exec) ----
  streamProc = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${env} exec bun mini-services/stream-service/index.ts`], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  streamProc.stdout!.on("data", (d) => console.log("[svc]", d.toString().trim()))
  streamProc.stderr!.on("data", (d) => console.log("[svc-err]", d.toString().trim()))

  await waitFor(async () => (await fetch(`${CONTROL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 20_000)

  // ---- app Next.js (dev, puerto aislado 3100; el proxy usa :8000/:8100 fijos) ----
  // detached + kill por GRUPO: bunx/next spawn hijos — SIGKILL al grupo los
  // recoge a todos y libera el puerto.
  appProc = spawn(
    "/bin/sh",
    ["-c", `cd '${ROOT}' && ${env} LOGIN_RATE_LIMIT_IP_MAX=500 exec bunx next dev -p ${APP_PORT}`],
    { stdio: ["ignore", "pipe", "pipe"], detached: true }
  )
  appProc.stdout!.on("data", (d) => console.log("[app]", d.toString().trim().slice(0, 200)))
  appProc.stderr!.on("data", (d) => console.log("[app-err]", d.toString().trim().slice(0, 200)))

  await waitFor(
    async () => (await fetch(`${APP}/api/health`).then((r) => r.status).catch(() => 0)),
    (s) => s === 200,
    120_000 // dev compila /api/health bajo demanda
  )

  // espera determinista de arranque completo del servicio de streaming
  await waitFor(async () => (await svcStatus()).hasKey, (k) => k === true, 10_000)
} else {
  console.warn(`⚠ stream-pipeline.test.ts: ${skipReason}`)
}

afterAll(() => {
  if (appProc) {
    try {
      process.kill(-appProc.pid!, "SIGKILL") // grupo completo
    } catch {
      appProc.kill("SIGKILL")
    }
    appProc = null
  }
  if (streamProc) {
    streamProc.kill("SIGKILL")
    streamProc = null
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
})

const d = (CAN_RUN ? describe : describe.skip) as typeof describe

d("FASE 23: pipeline de streaming real", () => {
  it("stream live: publisher RTMP → NMS → estado live en servicio y app", async () => {
    const pub = startPublisher()
    try {
      await waitFor(async () => (await svcStatus()).live, (l) => l === true, 20_000)
      const svc = await svcStatus()
      expect(svc.live).toBeTrue()
      expect(svc.hasKey).toBeTrue()
      expect(svc.publisherIp).toContain("127.0.0.1")

      // la app (proxy) refleja el estado: source local + serverOk + live
      const pubSt = await waitFor(publicStatus, (s) => s.live === true, 10_000)
      expect(pubSt.source).toBe("local")
      expect(pubSt.serverOk).toBeTrue()
    } finally {
      stopPublisher(pub)
    }
  }, 60_000)

  it("reproducción: FLV por el proxy con cabecera válida y flujo CONTINUO", async () => {
    const pub = startPublisher()
    try {
      await waitFor(async () => (await svcStatus()).live, (l) => l === true, 20_000)

      const sample = await sampleFlv(6000)
      expect(sample.status).toBe(200)
      expect(sample.contentType).toContain("video/x-flv")
      expect(sample.firstBytes).toBe("FLV")
      // continuidad: el flujo SIGUE entregando datos durante la ventana
      // (testsrc 640x360@24 ≈ 300-800 kbps). Umbrales conservadores por si el
      // dev-server compila la ruta en la primera petición (bajo carga los
      // chunks se coalescen: se exige flujo sostenido, no N chunks).
      expect(sample.chunks).toBeGreaterThanOrEqual(3)
      expect(sample.totalBytes).toBeGreaterThan(80_000)
    } finally {
      stopPublisher(pub)
    }
  }, 90_000)

  it("reconexión rápida: corte breve (< gracia NMS) → live NO baja y el FLV sigue", async () => {
    const pub1 = startPublisher()
    await waitFor(async () => (await svcStatus()).live, (l) => l === true, 20_000)

    // corte breve — OBS que se reconecta en segundos (ventana de reanudación)
    stopPublisher(pub1)
    await wait(3000)
    const pub2 = startPublisher()
    try {
      // durante la gracia (30s de NMS + diseño de reanudación) live se mantiene
      let stayedLive = true
      for (let i = 0; i < 6; i++) {
        await wait(1500)
        const st = await svcStatus()
        if (!st.live) stayedLive = false
      }
      expect(stayedLive).toBeTrue()

      // y el FLV vuelve a fluir por el proxy con el nuevo publicador
      const sample = await sampleFlv(4000)
      expect(sample.status).toBe(200)
      expect(sample.firstBytes).toBe("FLV")
      expect(sample.totalBytes).toBeGreaterThan(50_000)
    } finally {
      stopPublisher(pub2)
    }
  }, 90_000)

  it("caída: publisher detenido → live=false tras la gracia documentada (~33s)", async () => {
    const pub = startPublisher()
    await waitFor(async () => (await svcStatus()).live, (l) => l === true, 20_000)
    stopPublisher(pub)

    // NMS v4: PUBLISH_GRACE_MS=30s (ventana de reanudación de OBS) + 2.5s
    // de gracia propia del servicio → live=false llega ~32.5s después.
    await waitFor(async () => (await svcStatus()).live, (l) => l === false, 60_000)
    const pubSt = await publicStatus()
    expect(pubSt.live).toBeFalse()
  }, 90_000)

  it("recuperación: nuevo publisher tras la caída → live=true y FLV fluye", async () => {
    // estado previo: live=false (test anterior)
    expect((await svcStatus()).live).toBeFalse()

    const pub = startPublisher()
    try {
      await waitFor(async () => (await svcStatus()).live, (l) => l === true, 20_000)
      await waitFor(publicStatus, (s) => s.live === true, 10_000)

      const sample = await sampleFlv(4000)
      expect(sample.status).toBe(200)
      expect(sample.firstBytes).toBe("FLV")
      expect(sample.totalBytes).toBeGreaterThan(50_000)
    } finally {
      stopPublisher(pub)
    }
  }, 60_000)
})
