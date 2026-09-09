/**
 * Instalador multiplataforma (FASE 31 de la misión).
 *
 * Arquitectura (PASO 2-4 del plan):
 *   scripts/install.ts (este CLI) → comprobaciones preflight + entorno
 *       ↓
 *   initializeProduction() (scripts/lib/production-init.ts — sin stdin)
 *
 * Flujo para una MÁQUINA NUEVA sin editar código:
 *   1. Preflight: bun >= 1.1, node >= 20.9 (recomendado), git (opcional),
 *      espacio en disco (best-effort), permisos de escritura
 *   2. bun install (reproducible, --frozen-lockfile primero)
 *   3. Prisma Client (bunx prisma generate)
 *   4. .env con secretos ALEATORIOS (crypto) si no existe; DATABASE_URL
 *      ABSOLUTA; permisos 600 en Linux; nunca se imprime completo
 *   5. initializeProduction(): validar entorno → VERIFICAR target DB real
 *      (abort si mismatch) → migrate deploy → primer admin (política estricta)
 *      → settings → demo opcional → health checks
 *   6. Build standalone (omitible con --no-build)
 *   7. Resumen: URLs del panel/TV, OBS, documentación
 *
 * IDEMPOTENTE: re-ejecutar respeta .env y secretos existentes.
 * Multiplataforma: solo APIs de Node/Bun (fs/path/child_process) — sin
 * comandos POSIX embebidos (cp/rm/mkdir -p/nohup…); los wrappers .sh/.ps1
 * de deploy/ son capas opcionales por SO.
 *
 * Uso:
 *   bun scripts/install.ts                       # interactivo
 *   bun scripts/install.ts --email=a@b.c --password='Xy9!' --no-demo
 *   bun scripts/install.ts --no-build            # dev: sin compilar
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, statSync, statfsSync, rmSync, readFileSync, appendFileSync } from "fs"
import { networkInterfaces } from "os"
import { randomBytes } from "crypto"
import { execSync, spawnSync } from "child_process"
import { join, dirname } from "path"
import { ask, askPassword, closeStdin } from "./lib/prompt"
import { initializeProduction, PROJECT_ROOT } from "./lib/production-init"
import { readEnvFile } from "./lib/env-file"

const ENV_PATH = join(PROJECT_ROOT, ".env")

const flags = new Set(process.argv)
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")

const NO_BUILD = flags.has("--no-build")
const NO_DEMO = flags.has("--no-demo")

const OK = (s: string) => console.log(`✓ ${s}`)
const STEP = (s: string) => console.log(`\n→ ${s}`)
const WARN = (s: string) => console.log(`⚠ ${s}`)
const DIE = (s: string) => {
  console.error(`✗ ${s}`)
  process.exitCode = 1
  throw new Error(s)
}

function run(cmd: string): void {
  execSync(cmd, { stdio: "inherit", cwd: PROJECT_ROOT })
}

function versionAtLeast(v: string, min: string): boolean {
  const [maj, mino] = v.replace(/^v/, "").split(".").map(Number)
  const [M, m] = min.split(".").map(Number)
  return maj > M || (maj === M && mino >= m)
}

/** Genera un secreto hex seguro (crypto del runtime — multiplataforma). */
const secret = (bytes: number): string => randomBytes(bytes).toString("hex")

/** Preflight: SO, versiones, git, disco, permisos. Devuelve advertencias. */
function preflight(): string[] {
  const warnings: string[] = []

  const bunV = spawnSync("bun", ["--version"], { encoding: "utf8" })
  if (bunV.status !== 0 || !bunV.stdout) DIE("bun no está instalado. Instálalo: https://bun.sh")
  if (!versionAtLeast(bunV.stdout.trim(), "1.1.0")) DIE(`bun ${bunV.stdout.trim()} es antiguo; se necesita >= 1.1.0`)
  OK(`bun ${bunV.stdout.trim()}`)

  const nodeV = spawnSync("node", ["--version"], { encoding: "utf8" })
  if (nodeV.status === 0 && nodeV.stdout) {
    if (versionAtLeast(nodeV.stdout.trim(), "20.9.0")) OK(`node ${nodeV.stdout.trim()} (>= 20.9 ✓)`)
    else {
      WARN(`node ${nodeV.stdout.trim()} < 20.9 — bun ejecuta la app, pero actualiza Node para herramientas externas`)
      warnings.push("node < 20.9")
    }
  } else {
    WARN("node no está en PATH (bun basta para arrancar; OBS/ffmpeg son independientes)")
    warnings.push("node ausente")
  }

  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", cwd: PROJECT_ROOT })
  if (git.status === 0 && git.stdout?.trim() === "true") OK("repositorio git detectado")
  else {
    WARN("git ausente o no es un repo (no bloquea la instalación)")
    warnings.push("sin git")
  }

  // Espacio en disco (best-effort: statfs no está en todas las plataformas/FS)
  try {
    const st = statfsSync(PROJECT_ROOT) as unknown as { bavail: number; bsize: number }
    const freeGB = (st.bavail * st.bsize) / 1024 ** 3
    if (freeGB < 2) {
      WARN(`espacio libre bajo: ${freeGB.toFixed(1)} GB (node_modules+build+medios pueden necesitar más)`)
      warnings.push(`disco ${freeGB.toFixed(1)}GB`)
    } else OK(`espacio en disco: ${freeGB.toFixed(1)} GB libres`)
  } catch {
    WARN("no se pudo comprobar el espacio en disco (statfs no disponible)")
  }

  // Permisos de escritura en la raíz del proyecto
  try {
    const probe = join(PROJECT_ROOT, ".install-probe.tmp")
    writeFileSync(probe, "ok")
    rmSync(probe)
    OK("permisos de escritura verificados")
  } catch {
    DIE(`sin permisos de escritura en ${PROJECT_ROOT} (ejecuta como usuario con acceso)`)
  }

  return warnings
}

/** Genera .env si no existe (secretos aleatorios; DB absoluta; 600). */
function ensureEnv(): void {
  if (existsSync(ENV_PATH)) {
    const envStat = statSync(ENV_PATH)
    if (envStat.mode & 0o077) WARN("perms de .env abiertas para grupo/otros (chmod 600 recomendado en Linux)")

    // REPARACIÓN: .env existente pero incompleto (p. ej. template parcial o
    // secretos perdidos): se generan SOLO los que faltan — los valores
    // existentes se respetan (nunca se regenera un secreto que ya había).
    const cur = readEnvFile(ENV_PATH) ?? {}
    const repaired: string[] = []
    const append: string[] = []
    if (!cur.AUTH_SECRET) {
      append.push(`AUTH_SECRET="${secret(24)}"`)
      repaired.push("AUTH_SECRET")
    }
    if (!cur.REALTIME_TOKEN) {
      append.push(`REALTIME_TOKEN="${secret(16)}"`)
      repaired.push("REALTIME_TOKEN")
    }
    if (!cur.DATABASE_URL) {
      const dbDir = join(PROJECT_ROOT, "db")
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })
      const dbPath = join(dbDir, "custom.db").replace(/\\/g, "/")
      append.push(`DATABASE_URL="file:${dbPath}"`)
      repaired.push("DATABASE_URL (absoluta por defecto)")
    }
    if (append.length > 0) {
      appendFileSync(ENV_PATH, `\n# Secretos/valores regenerados por scripts/install.ts — ${new Date().toISOString()}\n${append.join("\n")}\n`)
      try {
        chmodSync(ENV_PATH, 0o600)
      } catch {
        /* noop */
      }
      WARN(`.env incompleto — regenerados (sin imprimir valores): ${repaired.join(", ")}`)
    } else {
      OK(".env ya existe y está completo — se respeta (los secretos NO se regeneran)")
    }
    return
  }
  const port = arg("port") ?? "3000"
  const timezone = arg("timezone") ?? "America/Havana"
  // Ruta de DB ABSOLUTA: las rutas relativas de file: se resuelven contra el
  // CWD de cada proceso (prisma CLI, server, mini-services), NO contra el
  // schema — un absoluto elimina toda ambigüedad (mismo patrón que
  // deploy/linux/install.sh y deploy/windows/install.ps1). Windows: slashes
  // normales (file:C:/...).
  const dbDir = join(PROJECT_ROOT, "db")
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, "custom.db").replace(/\\/g, "/")

  const env = `# Generado por scripts/install.ts (FASE 31) — ${new Date().toISOString()}
# Secreto de sesiones admin — aleatorio, NO commitear (ver .gitignore)
AUTH_SECRET="${secret(24)}"
# Token interno Next.js ↔ realtime-service
REALTIME_TOKEN="${secret(16)}"
# SQLite (ruta absoluta — portable entre prisma CLI / server / mini-services)
DATABASE_URL="file:${dbPath}"

# Puerto de la app
PORT=${port}
# Timezone inicial (editable luego desde el panel: Ajustes → Apariencia)
TIMEZONE=${timezone}
`
  writeFileSync(ENV_PATH, env, { mode: 0o600 })
  try {
    chmodSync(ENV_PATH, 0o600) // best-effort (Windows usa ACL propias)
  } catch {
    /* noop */
  }
  OK(".env generado con secretos aleatorios (crypto, sin openssl)")
  // No se imprime el contenido completo: los secretos no van a logs.
  console.log(`   · Puerto ${port} · Timezone ${timezone} · SQLite ${dbPath}`)
}

function lanIp(): string {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address
      }
    }
  } catch {
    /* noop */
  }
  return "<IP-del-servidor>"
}

async function main(): Promise<void> {
  console.log("=== ViewLBA — Instalación ===\n")

  // ---------- 1) Preflight ----------
  STEP("1/7 — Comprobando dependencias y entorno")
  preflight()

  // ---------- 2) Dependencias ----------
  STEP("2/7 — Instalando dependencias (bun install)")
  try {
    run("bun install --frozen-lockfile")
  } catch {
    WARN("--frozen-lockfile falló (lock desincronizado) — instalando con resolución normal")
    run("bun install")
  }
  OK("dependencias instaladas")

  // ---------- 3) Prisma Client ----------
  STEP("3/7 — Generando Prisma Client")
  run("bunx prisma generate")
  OK("Prisma Client generado")

  // ---------- 4) Entorno ----------
  STEP("4/7 — Configurando entorno (.env)")
  ensureEnv()

  // ---------- 5) Inicialización (core sin stdin) ----------
  STEP("5/7 — Inicializando la base de datos y el primer administrador")

  // Credenciales: flags → prompts interactivos → omitir (CI puede
  // inicializar solo DB y crear admin después con init-production).
  let email = arg("email")
  let password = arg("password")
  let withDemo: boolean | undefined = NO_DEMO ? false : undefined

  if (!email || !password) {
    const interactive = process.stdin.isTTY === true
    if (!email) email = (await ask("Email del administrador (Enter para omitir y hacerlo luego con init-production): ")).trim().toLowerCase() || undefined
    if (email && !password) {
      if (interactive) {
        for (;;) {
          const pw = await askPassword("Contraseña del administrador: ")
          const pw2 = await askPassword("Confirmar contraseña: ")
          if (pw === pw2) {
            password = pw
            break
          }
          console.log("✗ Las contraseñas no coinciden — reintenta.")
        }
      } else {
        password = (await ask("Contraseña del administrador: ")).trim() || undefined
      }
    }
    if (withDemo === undefined) {
      const answer = (await ask("¿Sembrar contenido demo? [s/N]: ")).trim().toLowerCase()
      withDemo = answer === "s" || answer === "si" || answer === "sí"
    }
  } else if (withDemo === undefined) {
    withDemo = false // flags de credenciales sin --demo → default conservador
  }

  // PASO 1 del protocolo: liberar stdin ANTES del trabajo pesado.
  closeStdin()

  // Target de DB: el .env (recién generado o existente) es la fuente local.
  const fileEnv = readEnvFile(ENV_PATH)
  const databaseUrl = fileEnv?.DATABASE_URL
  if (!databaseUrl) DIE("el .env no define DATABASE_URL — revisa el archivo manualmente")

  const result = await initializeProduction({
    envFile: ENV_PATH,
    databaseUrl,
    adminEmail: email,
    adminPassword: password,
    withDemoData: withDemo,
    healthChecks: true,
  })

  for (const s of result.steps) {
    const icon = s.status === "ok" ? "✓" : s.status === "skipped" ? "○" : s.status === "aborted" ? "⛔" : "✗"
    console.log(`${icon} ${s.name}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`)
  }
  if (!result.ok) DIE(result.error ?? "inicialización fallida")

  // ---------- 6) Build ----------
  if (NO_BUILD) {
    console.log("\n→ 6/7 — Build omitido (--no-build): arranca en modo dev con `bun run dev`")
  } else {
    STEP("6/7 — Compilando build de producción (standalone)")
    run("bun scripts/build.ts")
    OK("build standalone listo (.next/standalone)")
  }

  // ---------- 7) Resumen ----------
  STEP("7/7 — Resumen")
  const port = (() => {
    const m = /^\s*PORT=(\d+)/m.exec(readFileSync(ENV_PATH, "utf8"))
    return m?.[1] ?? arg("port") ?? "3000"
  })()
  const ip = lanIp()

  console.log(`
✅ INSTALACIÓN COMPLETA

   Panel de administración:  http://${ip}:${port}/?view=admin
   Pantalla TV:               http://${ip}:${port}/?view=tv
   Health:                    http://${ip}:${port}/api/health

   Cómo arrancar (elige UNO):
   · Desarrollo:      bun run dev  (y supervisores de mini-services: scripts/*-supervisor.sh)
   · Producción:      bun run start  (build standalone)
   · Linux systemd:   deploy/linux/install.sh  (servicios 24/7 + timers de backup)
   · Windows NSSM:    deploy/windows/install.ps1

   Streaming (OBS):  RTMP → rtmp://${ip}:1935/live  · clave desde el panel
                     (Sección Transmisión — solo ADMIN la revela)

   Documentación:    docs/OPERATIONS.md · docs/WINDOWS_PRODUCTION.md · README-LAN.md
`)
}

// ---------- Protocolo de finalización (igual que init-production) ----------
main()
  .then(() => {
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      console.error("[watchdog] cleanup completado pero el proceso sigue vivo (handle colgado de Bun); forzando salida.")
      process.exit(process.exitCode ?? 0)
    }, 6000)
    watchdog.unref?.()
  })
  .catch((e) => {
    console.error("\n✗ Instalación fallida:", (e as Error).message)
    process.exitCode = 1
    closeStdin()
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      console.error("[watchdog] salida forzada tras error (handle colgado de Bun).")
      process.exit(1)
    }, 6000)
    watchdog.unref?.()
  })
