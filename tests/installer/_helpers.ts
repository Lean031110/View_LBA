/**
 * Helpers para tests de regresión de instalador (misión §2).
 *
 * Lee archivos como texto y camina directorios para que los tests puedan
 * buscar patrones prohibidos en el código de producción.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

export const REPO_ROOT = resolve(import.meta.dir, "..", "..")

/** Camina recursivamente y devuelve archivos que matchean el patrón. */
export function walkAndCollect(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Directory doesn't exist — return empty (no matches)
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkAndCollect(full, pattern))
    } else if (pattern.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Lee un archivo del repo como texto (relativo a REPO_ROOT). */
export function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8")
}

/** Lee todos los archivos de un subdirectorio del repo. */
export function readRepoDir(rel: string, pattern: RegExp): Array<{ path: string; content: string }> {
  const abs = join(REPO_ROOT, rel)
  return walkAndCollect(abs, pattern).map((p) => ({
    path: p.replace(REPO_ROOT + "/", ""),
    content: readFileSync(p, "utf8"),
  }))
}

/**
 * Quita líneas de comentario de un texto plano.
 * Soporta estilos: ';' (NSIS), '#' (shell/ps1), '//' y '*' (C-like),
 * '/* ... *\/' (block), '<!-- -->' (xml).
 * El objetivo: permitir tests que busquen patrones PROHIBIDOS sin
 * flaggear menciones en comentarios que dicen "no usar X".
 */
export function stripComments(input: string): string {
  const lines = input.split(/\r?\n/)
  const out: string[] = []
  let inBlockComment = false
  for (let line of lines) {
    // Block comment start (/* ... */)
    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false
        line = line.replace(/^.*\*\//, "")
      } else {
        continue
      }
    }
    if (line.includes("/*")) {
      const before = line.split("/*")[0]
      if (line.includes("*/")) {
        line = before + line.split("*/").slice(1).join("*/")
      } else {
        inBlockComment = true
        line = before
      }
    }
    // XML comment block (<!-- -->)
    if (line.trim().startsWith("<!--")) {
      continue
    }
    // Inline comment detection: find the first non-string occurrence of comment marker
    // (this is heuristic — for v1 we just strip lines that START with a comment marker)
    const trimmed = line.trim()
    if (trimmed.startsWith(";") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")) {
      continue
    }
    // Strip inline comments after content (e.g. "code(); comment")
    // Be conservative: only strip "// ..." and "/* ... */" that appear AFTER a non-string char
    // For NSIS, ';' starts a comment until end of line
    if (line.includes(";")) {
      // For NSIS: ';' starts a comment (no string escape complication in .nsi)
      // But for TS/JS, ';' is a statement separator, not a comment.
      // Heuristic: if the file is .nsi or .ps1, strip from ';'; else keep.
      // For simplicity, we just keep the line as-is here.
    }
    out.push(line)
  }
  return out.join("\n")
}

/**
 * Lee un archivo del repo y devuelve su contenido SIN comentarios.
 * Útil para tests que buscan patrones prohibidos solo en código real.
 */
export function readRepoFileNoComments(rel: string): string {
  return stripComments(readRepoFile(rel))
}

