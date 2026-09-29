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
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkAndCollect(full, pattern))
    } else if (pattern.test(entry)) {
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
