/**
 * Instrumentación de Next.js — se ejecuta al arrancar el servidor
 * (dev y producción), ANTES de atender la primera petición.
 *
 * Uso principal: validación fail-fast del entorno (FASE 1 de la misión).
 * En producción, si faltan secretos → el proceso muere con mensaje claro
 * (misión: "si falta AUTH_SECRET → fallo de startup").
 *
 * Se omite durante `next build` (NEXT_PHASE=phase-production-build) porque
 * el build solo importa módulos y no debe requerir secretos reales.
 */
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return
  // En el runtime edge no hay entorno de servidor; NEXT_RUNTIME solo se
  // define en algunos contextos, por eso se comprueba de forma explícita
  // (undefined = arranque normal de servidor → SÍ validar).
  if (process.env.NEXT_RUNTIME === "edge") return

  const { envError } = await import("./lib/env")
  const err = envError()
  if (err) {
    // Nota: Next puede tragarse un `throw` dentro de register() en modo
    // standalone; process.exit garantiza el fallo de arranque real.
    console.error(err)
    process.exit(1)
  }
}
