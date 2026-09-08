/**
 * Inicialización de PRODUCCIÓN (FASE 18/31 de la misión).
 *
 * Crea el primer administrador con contraseña introducida por el operador
 * (NUNCA credenciales públicas conocidas). Pasos:
 *   1. valida entorno (env.ts — fail-fast si faltan secretos)
 *   2. prisma migrate deploy (sin destruir nada)
 *   3. primer ADMIN (email + contraseña con política, confirmación)
 *   4. contenido inicial (settings + contenido demo OPCIONAL sin usuarios)
 *   5. comprobaciones de salud (DB, realtime, stream si están corriendo)
 *
 * Uso: bun scripts/init-production.ts [--email=admin@mi-restaurante.com]
 */
import { PrismaClient } from "@prisma/client"
import { randomBytes, scryptSync } from "crypto"
import { execSync } from "child_process"
import { createInterface } from "readline"

const db = new PrismaClient()
const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
  return new Promise((res) => {
    // EOF (stdin cerrado/pipe vacío) → respuesta vacía (defaults seguros)
    rl.once("close", () => res(""))
    rl.question(question, res)
  })
}

function askPassword(): Promise<string> {
  return new Promise((res) => {
    // Ocultar entrada (mejor esfuerzo: stdin raw sin echo)
    const wasRaw = (process.stdin as { isRaw?: boolean }).isRaw ?? false
    try {
      process.stdin.setRawMode(true)
    } catch {
      /* no tty (CI) — sin eco oculto */
    }
    let input = ""
    const onData = (ch: Buffer) => {
      const c = ch.toString()
      if (c === "\r" || c === "\n") {
        try {
          process.stdin.setRawMode(wasRaw)
        } catch {}
        process.stdin.removeListener("data", onData)
        process.stdout.write("\n")
        res(input)
      } else if (c === "\u0003") {
        process.exit(1)
      } else if (c === "\u007f" || c === "\b") {
        if (input.length > 0) input = input.slice(0, -1)
      } else {
        input += c
        process.stdout.write("*")
      }
    }
    process.stdin.on("data", onData)
  })
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

/** Misma política que src/lib/validators.ts (fuente única de reglas) */
function validatePassword(pw: string): string | null {
  if (pw.length < 10) return "al menos 10 caracteres"
  if (!/[a-z]/.test(pw)) return "una letra minúscula"
  if (!/[A-Z]/.test(pw)) return "una letra mayúscula"
  if (!/\d/.test(pw)) return "un número"
  return null
}

async function main() {
  console.log("=== ViewLBA — Inicialización de PRODUCCIÓN ===\n")

  // 1) Entorno (los secretos se validan con el mismo criterio que el server)
  const { envError } = await import("../src/lib/env")
  const envErr = envError()
  if (envErr) {
    console.error(envErr)
    console.error("\n→ Copia .env.example a .env, genera los secretos (openssl rand -hex 24/16) y reintenta.")
    process.exit(1)
  }
  console.log("✓ Entorno validado (AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL)")

  // 2) Migraciones (NO destructivas — nunca db push)
  console.log("→ Aplicando migraciones (prisma migrate deploy)…")
  execSync("bunx prisma migrate deploy", { stdio: "inherit" })
  console.log("✓ Base de datos al día\n")

  // 3) Primer administrador
  const existing = await db.user.count({ where: { role: "ADMIN" } })
  if (existing > 0) {
    console.log(`Ya existen ${existing} administradores — se omite la creación (gestiónalos desde el panel).`)
  } else {
    const argEmail = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1]
    const argPassword = process.argv.find((a) => a.startsWith("--password="))?.split("=")[1]
    const email = (argEmail ?? (await ask("Email del administrador: "))).trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      console.error("✗ Email no válido")
      process.exit(1)
    }
    const taken = await db.user.findUnique({ where: { email } })
    if (taken) {
      console.error("✗ Ya existe un usuario con ese email")
      process.exit(1)
    }

    // Contraseña: --password= (no interactivo), TTY (oculta con confirmación)
    // o línea del stdin redirigido (automatización)
    let password: string
    if (argPassword) {
      password = argPassword
      const problem = validatePassword(password)
      if (problem) {
        console.error(`✗ La contraseña necesita ${problem}`)
        process.exit(1)
      }
      console.log("  (contraseña proporcionada por argumento — no se pide por teclado)")
    } else if ((process.stdin as { isTTY?: boolean }).isTTY) {
      for (;;) {
        const pw = await askPassword()
        const problem = validatePassword(pw)
        if (!problem) {
          const pw2 = await askPassword()
          if (pw === pw2) {
            password = pw
            break
          }
          console.log("✗ Las contraseñas no coinciden — reintenta.")
        } else {
          console.log(`✗ La contraseña necesita ${problem} — reintenta.`)
        }
      }
    } else {
      console.log("  (stdin sin TTY: escribe la contraseña y Enter)")
      password = (await ask("Contraseña del administrador: ")).trim()
      const problem = validatePassword(password)
      if (problem) {
        console.error(`✗ La contraseña necesita ${problem}`)
        process.exit(1)
      }
    }

    await db.user.create({
      data: { email, name: "Administrador", passwordHash: hashPassword(password), role: "ADMIN" },
    })
    console.log(`✓ Administrador creado: ${email}\n`)
  }

  // 4) Contenido inicial (sin usuarios; imágenes locales → LAN 100%)
  const skipDemo = process.argv.includes("--no-demo")
  const wantDemo = skipDemo ? "n" : (await ask("¿Sembrar contenido demo (promos/platos/horarios/ pantallas)? [s/N]: ")).trim().toLowerCase()
  if (wantDemo === "s" || wantDemo === "si" || wantDemo === "sí") {
    execSync("bun prisma/seed.ts", { stdio: "inherit" })
  } else {
    // Mínimo imprescindible: settings para que la app funcione
    await db.settings.upsert({
      where: { id: "main" },
      update: {},
      create: {
        id: "main",
        restaurantName: "Mi Restaurante",
        streamEnabled: true,
        streamUrl: "",
        fallbackMessage: "LA TRANSMISIÓN SE REANUDARÁ EN BREVE",
      },
    })
    console.log("✓ Ajustes base creados (configura el resto desde el panel)")
  }

  // 5) Salud de servicios (si están corriendo)
  console.log("\n=== Comprobaciones de salud ===")
  for (const [name, url, must] of [
    ["App Next.js", "http://127.0.0.1:3000/api/health", false],
    ["Realtime service", "http://127.0.0.1:3004/health", false],
    ["Stream service", "http://127.0.0.1:8100/health", false],
  ] as const) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      console.log(`${res.ok ? "✓" : "⚠"} ${name}: ${res.status}`)
    } catch {
      console.log(`○ ${name}: no responde ${must ? "(REQUERIDO)" : "(se iniciará con los servicios)"}`)
    }
  }

  console.log("\n✅ Inicialización COMPLETA.")
  console.log("   Siguiente: arranca los servicios (docs/LINUX_PRODUCTION.md o los supervisores)")
  console.log("   y abre el panel en http://<IP-del-servidor>:3000/?view=admin")
}

main()
  .catch((e) => {
    console.error("Error:", e)
    process.exit(1)
  })
  .finally(() => {
    rl.close()
    db.$disconnect()
  })
