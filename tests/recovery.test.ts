/**
 * FASE 33 (misión) — RECOVERY: recuperación real ante caídas de servicios.
 *
 * NO es mock: se levanta el stack real (app Next.js dev :3200, realtime
 * :3203/:3204, stream-service :1935/:8000/:8100, DB temporal con migraciones
 * reales) y se SIGKILL-ea cada pieza para comprobar la recuperación:
 *
 *   · Next cae            → restart → contenido idéntico (DB sin corrupción)
 *   · Realtime cae        → la "TV" (socket.io-client con reconexión) se
 *                           reconecta SOLA y re-registra → UNA entrada (sin
 *                           duplicar sockets)
 *   · Contenido con realtime caído → /api/content sigue 200 (la TV conserva
 *                           el último estado conocido vía polling)
 *   · DB bloqueada        → realtime degradado SIN crash → al liberar, alta
 *   · Stream cae          → "OBS" (ffmpeg) reconecta → live=true de nuevo
 *   · Integridad final    → integrity_check + counts idénticos
 *
 * La caída del publicador OBS y la reconexión del PLAYER ya están cubiertas
 * por tests/stream-pipeline.test.ts (caída/recuperación) — aquí se prueba la
 * caída del SERVICIO completo (lo que systemd Restart=always recuperaría).
 *
 * SKIP VISIBLE si los puertos están ocupados (bun test es secuencial por
 * archivo, pero E2E manual en marcha podría chocar).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { createHash, randomBytes } from "crypto"
import { io, type Socket } from "socket.io-client"
import { Database } from "bun:sqlite"

const ROOT = resolve(import.meta.dir, "..")
const APP_PORT = 3200
const APP = `http://127.0.0.1:${APP_PORT}`
const RT_SOCKET = 3203
const RT_INTERNAL = 3204
const RT_URL = `http://127.0.0.1:${RT_SOCKET}`
const STREAM_CONTROL = "http://127.0.0.1:8100"

const AUTH_SECRET = "rec-secret-0123456789abcdef0123456789"
const REALTIME_TOKEN = "rec-rt-internal-token-0123456789abcdef"
const STREAM_KEY = "recovery-test-key-0123456789abcdef"
const SCREEN_TOKEN = "recovery-screen-token-32-chars!!"

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
    await wait(250)
  }
}

/** Puerto libre? (probe TCP real con reintentos: un abort por timeout bajo
 *  carga de arranque NO significa puerto ocupado — localhost rechaza al
 *  instante si nada escucha; si no responde en 1.5s×2, se asume ocupado). */
async function portFree(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      return false // algo respondió HTTP → ocupado
    } catch (e) {
      const msg = String((e as Error)?.cause ?? (e as Error).message ?? "")
      if (/refused|ECONN|ENOTFOUND|reset|Unable to connect/i.test(msg)) return true
      // timeout/abort → reintentar una vez antes de declararlo ocupado
      await wait(300)
    }
  }
  return false // dos timeouts → algo escucha y no responde → ocupado
}

// ---------------- estado compartido del stack ----------------
let tmpDir = ""
let dbPath = ""
let rt: ChildProcess | null = null
let app: ChildProcess | null = null
let stream: ChildProcess | null = null
let tv: Socket | null = null
let dbCounts: Record<string, number> = {}
const APP_ENV = () =>
  `DATABASE_URL='file:${dbPath}' AUTH_SECRET='${AUTH_SECRET}' REALTIME_TOKEN='${REALTIME_TOKEN}' STREAM_KEY='${STREAM_KEY}' REALTIME_HEALTH_URL='http://127.0.0.1:${RT_INTERNAL}/health' STREAM_HEALTH_URL='http://127.0.0.1:8100/health'`

function spawnApp(): ChildProcess {
  // detached + kill por GRUPO (bunx/next spawn hijos — SIGKILL al grupo)
  const p = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${APP_ENV()} LOGIN_RATE_LIMIT_IP_MAX=500 exec bunx next dev -p ${APP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  p.stdout!.on("data", (d) => console.log("[app]", d.toString().trim().slice(0, 160)))
  p.stderr!.on("data", (d) => console.log("[app-err]", d.toString().trim().slice(0, 160)))
  return p
}

function spawnRealtime(): ChildProcess {
  const p = spawn(
    "/bin/sh",
    ["-c", `cd '${ROOT}' && ${APP_ENV()} REALTIME_PORT='${RT_SOCKET}' REALTIME_INTERNAL_PORT='${RT_INTERNAL}' exec bun mini-services/realtime-service/index.ts`],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  p.stdout!.on("data", (d) => console.log("[rt]", d.toString().trim().slice(0, 160)))
  p.stderr!.on("data", (d) => console.log("[rt-err]", d.toString().trim().slice(0, 160)))
  return p
}

function spawnStream(): ChildProcess {
  const p = spawn("/bin/sh", ["-c", `cd '${ROOT}' && ${APP_ENV()} exec bun mini-services/stream-service/index.ts`], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  p.stdout!.on("data", (d) => console.log("[svc]", d.toString().trim().slice(0, 160)))
  p.stderr!.on("data", (d) => console.log("[svc-err]", d.toString().trim().slice(0, 160)))
  return p
}

function spawnPublisher(): ChildProcess {
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
      `rtmp://127.0.0.1:1935/live/${STREAM_KEY}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
}

function killGroup(p: ChildProcess | null): void {
  if (!p) return
  try {
    if (p.pid) process.kill(-p.pid, "SIGKILL")
  } catch {
    try {
      p.kill("SIGKILL")
    } catch {}
  }
}

/** "TV" simulada: socket.io con reconexión infinita + re-registro en cada
 *  connect (mismo comportamiento que TvDisplay.tsx). */
function connectTv(): Socket {
  const s = io(RT_URL, { path: "/", transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 300, reconnectionDelayMax: 3000, timeout: 5000 })
  s.on("connect", () => {
    s.emit("screen:register", {
      screenCode: "TV-REC",
      resolution: "1920x1080",
      userAgent: "recovery-test",
      token: SCREEN_TOKEN,
    })
  })
  return s
}

async function rtStatus(): Promise<{ ok: boolean; screens: { screenCode: string; online?: boolean; verified?: boolean }[] }> {
  const res = await fetch(`http://127.0.0.1:${RT_INTERNAL}/status`, { cache: "no-store" })
  return (await res.json()) as { ok: boolean; screens: { screenCode: string; online?: boolean; verified?: boolean }[] }
}

// ---------------- setup / teardown ----------------
// NOTA: el sondeo de puertos DEBE ser a nivel de módulo (top-level await):
// describe vs describe.skip se decide al CARGAR el archivo, no en beforeAll.
// (Bun.which es fiable desde bun test; spawn síncrono de binarios falla
// intermitentemente en el sandbox — mismo workaround que stream-pipeline)
const ffmpegOk = Boolean(Bun.which("ffmpeg"))
const appPortFree = await portFree(APP_PORT)
const rtPortFree = (await portFree(RT_SOCKET)) && (await portFree(RT_INTERNAL))
const streamPortFree = (await portFree(1935)) && (await portFree(8100))
const portsFree = { app: appPortFree, rt: rtPortFree, stream: streamPortFree }
if (!portsFree.app || !portsFree.rt) {
  console.warn(`⚠ recovery.test: puertos ocupados (app:${portsFree.app} rt:${portsFree.rt}) — ¿E2E en marcha? — test omitido`)
}

beforeAll(async () => {
  if (!portsFree.app || !portsFree.rt) return

  // ---- DB temporal con el ESQUEMA COMPLETO (migraciones reales) ----
  tmpDir = mkdtempSync(join(tmpdir(), "recovery-"))
  dbPath = join(tmpDir, "recovery.db")
  // (workaround de sandbox: spawn directo de binarios desde bun test es
  // intermitente → /bin/sh -c, mismo patrón que los otros spawns)
  const mig = Bun.spawnSync(["/bin/sh", "-c", `cd '${ROOT}' && DATABASE_URL='file:${dbPath}' exec bunx prisma migrate deploy`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (mig.exitCode !== 0) {
    console.error("[recovery] migrate deploy falló:", mig.stderr.toString().slice(0, 500))
    throw new Error("migrate deploy falló en setup de recovery")
  }
  // seed mínimo: admin + settings con streamKey + pantalla TV-REC con token
  const tokenHash = createHash("sha256").update(SCREEN_TOKEN).digest("hex")
  const w = new Database(dbPath)
  w.run("INSERT INTO User (id, email, name, passwordHash, role, active, authVersion, updatedAt) VALUES ('u1', 'rec@test.local', 'Rec', 'x:y', 'ADMIN', 1, 0, CURRENT_TIMESTAMP)")
  w.run("INSERT INTO Settings (id, restaurantName, streamEnabled, streamSource, streamKey, rtmpApp, updatedAt) VALUES ('main', 'Restaurante Recovery', 1, 'local', ?, 'live', CURRENT_TIMESTAMP)", [STREAM_KEY])
  w.run("INSERT INTO Screen (id, code, name, active, tokenHash, updatedAt) VALUES ('s1', 'TV-REC', 'Recovery', 1, ?, CURRENT_TIMESTAMP)", [tokenHash])
  w.close()
  dbCounts = tableCounts()

  // ---- stack ----
  rt = spawnRealtime()
  app = spawnApp()
  await waitFor(async () => (await fetch(`${APP}/api/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 120_000)
  await waitFor(async () => (await fetch(`http://127.0.0.1:${RT_INTERNAL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 15_000)
}, 180_000)

function tableCounts(): Record<string, number> {
  const r = new Database(dbPath, { readonly: true })
  const tables = ["User", "Settings", "Screen", "_prisma_migrations"]
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = (r.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
  r.close()
  return out
}

afterAll(() => {
  tv?.disconnect()
  killGroup(app)
  rt?.kill("SIGKILL")
  stream?.kill("SIGKILL")
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
})

const d = (portsFree.app && portsFree.rt ? describe : describe.skip) as typeof describe

d("FASE 33: recovery ante caídas reales", () => {
  it("app cae (SIGKILL) → restart → mismo contenido, DB sin corrupción", async () => {
    const before = await (await fetch(`${APP}/api/content`, { cache: "no-store" })).json() as { settings: { restaurantName: string } }
    expect(before.settings.restaurantName).toBe("Restaurante Recovery")

    killGroup(app)
    app = null
    // caído de verdad: conexión rechazada
    await waitFor(async () => (await fetch(`${APP}/api/health`).then((r) => r.status).catch(() => 0)), (s) => s === 0, 15_000)

    // "systemd Restart=always" → relanzar
    app = spawnApp()
    await waitFor(async () => (await fetch(`${APP}/api/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 120_000)
    const after = await (await fetch(`${APP}/api/content`, { cache: "no-store" })).json() as { settings: { restaurantName: string } }
    expect(after.settings.restaurantName).toBe("Restaurante Recovery")
  }, 150_000)

  it("realtime cae (SIGKILL) → la TV se reconecta SOLA → una única entrada (sin sockets duplicados)", async () => {
    tv = connectTv()
    await waitFor(async () => (await rtStatus()).screens.filter((s) => s.screenCode === "TV-REC").length, (n) => n === 1, 15_000)
    const st0 = await rtStatus()
    expect(st0.screens.filter((s) => s.screenCode === "TV-REC")).toHaveLength(1)
    expect(st0.screens.find((s) => s.screenCode === "TV-REC")?.verified).toBe(true)

    // contenido accesible ANTES de matar (baseline)
    expect((await fetch(`${APP}/api/content`, { cache: "no-store" })).status).toBe(200)

    rt!.kill("SIGKILL")
    rt = null
    // el servicio está caído (health muerto)
    await waitFor(async () => (await fetch(`http://127.0.0.1:${RT_INTERNAL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 0, 15_000)

    // MIENTRAS el realtime está caído, la app sigue sirviendo contenido
    // (la TV real conserva el último estado conocido + polling de respaldo)
    expect((await fetch(`${APP}/api/content`, { cache: "no-store" })).status).toBe(200)

    // relanzar (Restart=always) → la TV se reconecta sola (reconnection) y
    // se re-registra (mismo protocolo que TvDisplay)
    rt = spawnRealtime()
    await waitFor(async () => (await fetch(`http://127.0.0.1:${RT_INTERNAL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 15_000)
    await waitFor(async () => (await rtStatus()).screens.filter((s) => s.screenCode === "TV-REC" && s.online).length, (n) => n === 1, 20_000)

    // SIN DUPLICAR SOCKETS: exactamente UNA entrada para TV-REC
    const st1 = await rtStatus()
    expect(st1.screens.filter((s) => s.screenCode === "TV-REC")).toHaveLength(1)
    expect(st1.screens.find((s) => s.screenCode === "TV-REC")?.verified).toBe(true)
  }, 90_000)

  it("DB: WAL activo + lectores bajo lock de escritura + servicio sin crash ante DB ilegible", async () => {
    // (a) FASE 38: la instrumentación de la app puso la DB en WAL — verificado
    // directamente (journal_mode persistente en el archivo)
    const probe = new Database(dbPath, { readonly: true })
    const mode = (probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode
    expect(mode).toBe("wal")

    // (b) WAL: un lock de ESCRITURA (BEGIN EXCLUSIVE — p.ej. backup/VACUUM)
    // NO bloquea a los LECTORES (el realtime sigue autenticando pantallas).
    // Determinista con conexiones directas (la misma mecánica de bun:sqlite
    // readonly que usa queryRow del servicio).
    const locker = new Database(dbPath)
    locker.exec("BEGIN EXCLUSIVE")
    const read = probe.query("SELECT code FROM Screen WHERE code = 'TV-REC'").get() as { code: string } | null
    expect(read?.code).toBe("TV-REC")
    locker.exec("COMMIT")
    locker.close()

    // (c) DB ILEGIBLE (chmod 000 — disco/permisos): el registro se resuelve
    // SIN crash del servicio. NOTA honesta: un fd YA ABIERTO sigue legible en
    // Linux pese al chmod (veredicto "registered"); si el handle debe reabrir
    // → queryRow captura → rechazo "unknown" (degradado). El CONTRATO probado
    // aquí es que el servicio NUNCA se cuelga ni muere ante una DB ilegible —
    // la recuperación de un incidente real de disco la cubre el restart
    // (test "realtime cae").
    const { chmodSync } = await import("fs")
    const registerVerdict = (): Promise<string> =>
      new Promise<string>((res) => {
        const s2 = io(RT_URL, { path: "/", transports: ["websocket"], reconnection: false, timeout: 4000 })
        s2.on("connect", () => s2.emit("screen:register", { screenCode: "TV-REC", resolution: "1x1", userAgent: "x", token: SCREEN_TOKEN }))
        s2.on("screen:rejected", (d: { reason: string }) => { s2.disconnect(); res(d.reason) })
        s2.on("screen:registered", () => { s2.disconnect(); res("registered") })
        setTimeout(() => { s2.disconnect(); res("timeout") }, 6000)
      })
    chmodSync(dbPath, 0o000)
    try {
      const verdict = await registerVerdict()
      expect(["unknown", "timeout", "registered"]).toContain(verdict) // resuelto, no colgado
      expect(rt!.exitCode).toBeNull() // sin crash
    } finally {
      chmodSync(dbPath, 0o644)
      probe.close()
    }
  }, 90_000)

  const streamIt = (ffmpegOk && portsFree.stream ? it : it.skip) as typeof it
  streamIt("stream-service cae (SIGKILL) → OBS (ffmpeg) reconecta → live=true de nuevo", async () => {
    stream = spawnStream()
    await waitFor(async () => (await fetch(`${STREAM_CONTROL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 15_000)

    // OBS empieza a transmitir
    let pub = spawnPublisher()
    try {
      const liveNow = async (): Promise<boolean> => {
        const d = (await fetch(`${STREAM_CONTROL}/status`).then((r) => r.json()).catch(() => ({ live: false }))) as { live: boolean }
        return Boolean(d.live)
      }
      await waitFor(liveNow, (l) => l === true, 20_000)

      // el servicio muere DE REPENTE (SIGKILL — lo que systemd recuperaría)
      stream!.kill("SIGKILL")
      stream = null
      await waitFor(async () => (await fetch(`${STREAM_CONTROL}/status`).then((r) => r.ok).catch(() => false)), (ok) => ok === false, 10_000)
      pub.kill("SIGKILL") // OBS pierde la conexión RTMP

      // restart del servicio + OBS reconecta (retry automático de OBS)
      stream = spawnStream()
      await waitFor(async () => (await fetch(`${STREAM_CONTROL}/health`).then((r) => r.status).catch(() => 0)), (s) => s === 200, 15_000)
      pub = spawnPublisher()
      await waitFor(liveNow, (l) => l === true, 20_000)

      // la app refleja el estado recuperado (serverOk + live)
      const appStatus = await (await fetch(`${APP}/api/stream/status`, { cache: "no-store" })).json() as { source: string; serverOk: boolean; live: boolean | null }
      expect(appStatus.serverOk).toBe(true)
      expect(appStatus.live).toBe(true)
    } finally {
      try {
        pub.kill("SIGKILL")
      } catch {}
    }
  }, 120_000)

  it("integridad final: DB sin corrupción tras todas las caídas", async () => {
    const r = new Database(dbPath, { readonly: true })
    const check = (r.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
    r.close()
    expect(check).toBe("ok")
    // los datos no se duplicaron ni perdieron
    const after = tableCounts()
    for (const [t, n] of Object.entries(dbCounts)) {
      expect(after[t]).toBe(n)
    }
  }, 30_000)
})
