/**
 * CLI de inicialización de PRODUCCIÓN (FASE 18/31).
 *
 * Delgado: recoge credenciales (flags, prompts interactivos o stdin) y
 * delega TODA la lógica en `initializeProduction()` (scripts/lib/production-init.ts),
 * que no lee stdin. Así el mismo flujo sirve para Linux, Windows, CI,
 * automatización, pruebas e instalación silenciosa.
 *
 * Protocolo de finalización (PASO 1 — bug readline/stdin de Bun):
 *   1. rl.close() (closeStdin)
 *   2. process.stdin.unref()
 *   3. cleanup restante (la core ya desconecta Prisma)
 *   4. salida NATURAL (process.exitCode); process.exit() SOLO como watchdog
 *      de seguridad que deja evidencia en log — nunca como mecanismo normal.
 *
 * Uso: bun scripts/init-production.ts [--email=a@b.c] [--password=X]
 *      [--database-url=file:...] [--env=.env] [--demo|--no-demo]
 */
import { join } from "path"
import { ask, askPassword, closeStdin } from "./lib/prompt"
import { initializeProduction, PROJECT_ROOT, type InitializeResult } from "./lib/production-init"

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")

const flags = new Set(process.argv)

function printResult(r: InitializeResult): void {
  console.log("\n=== Resultado ===")
  for (const s of r.steps) {
    const icon = s.status === "ok" ? "✓" : s.status === "skipped" ? "○" : s.status === "aborted" ? "⛔" : "✗"
    console.log(`${icon} ${s.name}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`)
  }
}

async function collectCredentials(haveEmail?: string, havePassword?: string) {
  let email = haveEmail
  let password = havePassword
  if (!email) email = (await ask("Email del administrador: ")).trim().toLowerCase()
  if (!password) {
    if (process.stdin.isTTY === true) {
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
      console.log("  (stdin sin TTY: escribe la contraseña y Enter)")
      password = (await ask("Contraseña del administrador: ")).trim()
    }
  }
  return { email, password }
}

async function main(): Promise<number> {
  console.log("=== ViewLBA — Inicialización de PRODUCCIÓN ===\n")

  const envFile = arg("env") ?? join(PROJECT_ROOT, ".env")
  const databaseUrl = arg("database-url")

  let email = arg("email")
  let password = arg("password")
  let withDemo: boolean | undefined

  if (flags.has("--no-demo")) withDemo = false
  if (flags.has("--demo")) withDemo = true

  // Credenciales: flags → prompts (el email se pide también sin TTY: ask()
  // funciona en pipes). Solo se pregunta lo que falta.
  if (!email || !password) {
    const creds = await collectCredentials(email, password)
    email = email ?? creds.email
    password = password ?? creds.password
  }

  if (withDemo === undefined) {
    const answer = (await ask("¿Sembrar contenido demo (promos/platos/horarios/pantallas)? [s/N]: ")).trim().toLowerCase()
    withDemo = answer === "s" || answer === "si" || answer === "sí"
  }

  // PASO 1 del protocolo: cerrar readline y liberar stdin ANTES del trabajo
  // pesado posterior (la core no usa stdin y puede tardar en migraciones).
  closeStdin()

  const result = await initializeProduction({
    envFile,
    databaseUrl,
    adminEmail: email || undefined,
    adminPassword: password || undefined,
    withDemoData: withDemo,
    healthChecks: true,
  })

  printResult(result)

  if (!result.ok) {
    console.error(`\n✗ ${result.error ?? "inicialización fallida"}`)
    return 1
  }

  console.log("\n✅ Inicialización COMPLETA.")
  console.log("   Siguiente: arranca los servicios (docs/OPERATIONS.md o los supervisores)")
  console.log("   y abre el panel en http://<IP-del-servidor>:3000/?view=admin")
  return 0
}

// ---------- Protocolo de finalización ----------
// El exit es NATURAL (exitCode). El watchdog SOLO cubre el bug de Bun en el
// que un handle de stdin/readline mantiene el proceso vivo tras el cleanup;
// deja evidencia en log y NUNCA reemplaza el cleanup normal.
main()
  .then((code) => {
    process.exitCode = code
    // cleanup ya hecho: la core desconectó Prisma; closeStdin() se llamó antes.
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      console.error("[watchdog] cleanup completado pero el proceso sigue vivo (handle colgado de Bun); forzando salida.")
      process.exit(process.exitCode ?? 0)
    }, 6000)
    watchdog.unref?.()
  })
  .catch((e) => {
    console.error("Error:", e)
    process.exitCode = 1
    closeStdin()
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      console.error("[watchdog] salida forzada tras error (handle colgado de Bun).")
      process.exit(1)
    }, 6000)
    watchdog.unref?.()
  })
