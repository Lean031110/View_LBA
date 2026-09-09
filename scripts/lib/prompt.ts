/**
 * Prompts interactivos con ciclo de vida CORRECTO (FASE 31, PASO 1).
 *
 * Bug que resuelve: `node:readline` sobre `process.stdin` mantiene el handle
 * de stdin abierto y el proceso Bun puede no terminar hasta recibir EOF.
 * La documentación de Bun recomienda `process.stdin.unref()`. Protocolo
 * obligatorio al terminar cualquier CLI que use estos prompts:
 *
 *   1. cerrar readline (rl.close());
 *   2. liberar stdin (process.stdin.unref());
 *   3. después realizar el resto del cleanup (disconnects);
 *   4. NO dejar readline activo al finalizar.
 *
 * `closeStdin()` implementa 1+2. El CLI llama closeStdin() ANTES de los
 * disconnects, y jamás usa process.exit() como mecanismo normal.
 */
import { createInterface, type Interface } from "readline"

let rl: Interface | null = null

function getRl(): Interface {
  if (!rl) {
    // `terminal: false` cuando stdin NO es TTY (pipes/CI): evita que readline
    // ponga el terminal en raw mode y evita el eco raro en automatización.
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    })
  }
  return rl
}

/** Pregunta de texto plano (funciona en TTY y en pipes). */
export function ask(question: string): Promise<string> {
  return new Promise((res) => {
    const iface = getRl()
    // EOF (stdin cerrado/pipe vacío) → respuesta vacía (defaults seguros)
    iface.once("close", () => res(""))
    iface.question(question, (answer) => res(answer))
  })
}

/** Pregunta de contraseña oculta (solo TTY; en pipe se lee a cielo abierto). */
export function askPassword(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    // Sin TTY (automatización): leer como línea normal — la responsabilidad
    // de no poner secrets en pipes es del operador (flags --password=).
    return ask(prompt)
  }
  return new Promise((res) => {
    const wasRaw = (process.stdin as { isRaw?: boolean }).isRaw ?? false
    try {
      process.stdin.setRawMode(true)
    } catch {
      /* sin raw mode disponible: caer a ask() */
      ask(prompt).then(res)
      return
    }
    let input = ""
    const onData = (ch: Buffer) => {
      const c = ch.toString()
      if (c === "\r" || c === "\n") {
        try {
          process.stdin.setRawMode(wasRaw)
        } catch {
          /* noop */
        }
        process.stdin.removeListener("data", onData)
        process.stdout.write("\n")
        res(input)
      } else if (c === "\u0003") {
        // Ctrl+C en raw mode no genera SIGINT: emularlo
        try {
          process.stdin.setRawMode(wasRaw)
        } catch {
          /* noop */
        }
        process.stdin.removeListener("data", onData)
        process.stdout.write("\n")
        process.exit(130)
      } else if (c === "\u007f" || c === "\b") {
        if (input.length > 0) input = input.slice(0, -1)
      } else {
        input += c
        process.stdout.write("*")
      }
    }
    process.stdout.write(prompt)
    process.stdin.on("data", onData)
  })
}

/**
 * PASO 1+2 del protocolo: cerrar readline y liberar stdin.
 * Idempotente. Debe llamarse ANTES de los disconnects finales del CLI.
 */
export function closeStdin(): void {
  try {
    rl?.close()
  } catch {
    /* noop */
  }
  rl = null
  const stdin = process.stdin as unknown as { unref?: () => void; readable?: boolean }
  try {
    if (process.stdin.isTTY || stdin.readable) stdin.unref?.()
  } catch {
    /* noop */
  }
}

/** ¿Hay readline activo? (diagnóstico) */
export function stdinOpen(): boolean {
  return rl !== null
}
