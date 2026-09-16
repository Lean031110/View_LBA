/**
 * ViewLBA — Gate de coherencia de documentación (README/enlaces/badges).
 *
 * Este script FAIL (exit 1) si la documentación deja de ser fiel al repo:
 *   · Badges del README apuntan al repositorio REAL (el de package.json).
 *   · Los workflows referenciados por los badges existen en .github/workflows/.
 *   · Ninguna instrucción `git clone` apunta a un repo distinto del real
 *     (regresión histórica: el README decía "Pantalla_Restaurante" cuando el
 *     repo real es "View_LBA").
 *   · Todos los enlaces relativos del README (docs/, screenshots, archivos)
 *     apuntan a archivos EXISTENTES.
 *   · Índice de docs completo: cada docs/*.md de primer nivel está enlazado
 *     desde el README (que una guía quede huérfana es un error).
 *   · Los conteos E2E publicados (specs / tests / escenarios) coinciden con
 *     el código real de e2e/ (que el README diga "37 specs" cuando hay 9
 *     es un error que este gate impide).
 *   · El conteo de tests unitarios publicado está en banda con el código
 *     real de tests/ (el runtime añade expansiones .each; el conteo
 *     estático es el suelo y 1.15× el techo).
 *
 * Ejecutado en CI (job quality) y auditable localmente:
 *   bun scripts/check-docs.ts
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const fail = (msg: string): never => {
  console.error(`✗ [check-docs] ${msg}`)
  process.exit(1)
}
const ok = (msg: string): void => console.log(`✓ ${msg}`)

const REPO = "Lean031110/View_LBA"

// ---------------------------------------------------------------------------
// 0. Archivos base
// ---------------------------------------------------------------------------
if (!existsSync("README.md")) fail("falta README.md")
const readme = readFileSync("README.md", "utf8")

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  repository?: { url?: string }
}
const pkgUrl = pkg.repository?.url ?? ""
if (!pkgUrl.includes(`github.com/${REPO}`)) {
  fail(`package.json repository.url (${pkgUrl}) no apunta a github.com/${REPO}`)
}
ok(`package.json → ${REPO}`)

// ---------------------------------------------------------------------------
// 1. Badges: repositorio real + workflows existentes
// ---------------------------------------------------------------------------
const badgeRepos = [...readme.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/actions/g)].map((m) => m[1])
if (badgeRepos.length === 0) fail("el README no tiene badges de GitHub Actions")
for (const r of new Set(badgeRepos)) {
  if (r !== REPO) fail(`badge de Actions apunta a '${r}' (debe ser ${REPO})`)
}
ok(`badges de Actions → ${REPO} (${badgeRepos.length} enlaces)`)

const badgeWfs = [...readme.matchAll(/actions\/workflows\/([\w.-]+\.yml)/g)].map((m) => m[1])
for (const wf of new Set(badgeWfs)) {
  if (!existsSync(join(".github", "workflows", wf))) {
    fail(`badge referencia .github/workflows/${wf} que NO existe`)
  }
}
ok(`workflows de los badges existen (${[...new Set(badgeWfs)].join(", ")})`)

// ---------------------------------------------------------------------------
// 2. Instrucciones git clone: solo el repo real (guarda de regresión)
// ---------------------------------------------------------------------------
const clones = [...readme.matchAll(/git clone (\S+)/g)].map((m) => m[1])
if (clones.length === 0) fail("el README no documenta cómo clonar el repositorio")
for (const c of clones) {
  if (c !== `https://github.com/${REPO}.git`) {
    fail(`git clone apunta a '${c}' — solo https://github.com/${REPO}.git es válido`)
  }
}
ok(`git clone → ${REPO}.git`)

for (const docFile of ["CONTRIBUTING.md", "docs/INSTALLATION.md"]) {
  if (!existsSync(docFile)) continue
  const text = readFileSync(docFile, "utf8")
  if (/Pantalla_Restaurante/.test(text)) {
    fail(`${docFile} todavía referencia el nombre antiguo del repo (Pantalla_Restaurante)`)
  }
  const badClone = [...text.matchAll(/git clone (\S+)/g)].map((m) => m[1]).find((c) => !c.includes(REPO))
  if (badClone) fail(`${docFile}: git clone apunta a '${badClone}'`)
}
ok("CONTRIBUTING.md y docs/INSTALLATION.md clonan el repo correcto")

// 2b. Tooling de release: NINGÚN script activo puede apuntar al nombre
//     antiguo del repo (regresión v3.2.2: publish-github.sh usaba
//     Pantalla_Restaurante con curl -sf sin -L → 301 silencioso; el
//     Homepage del .deb apuntaba al nombre viejo).
const RELEASE_TOOLING = [
  "installer/linux/build-deb.ts",
  "installer/package/bundle-server.ts",
  "installer/package/appimage.sh",
  "installer/package/appimage-gui.sh",
  "installer/windows/viewlba-setup.nsi",
  "scripts/publish-github.sh",
  "scripts/monitor-release.py",
  "scripts/monitor-release2.sh",
  "MISSION.md",
  "README-LAN.md",
]
for (const toolFile of RELEASE_TOOLING) {
  if (!existsSync(toolFile)) continue
  const text = readFileSync(toolFile, "utf8")
  if (/Pantalla_Restaurante/.test(text)) {
    fail(`${toolFile} referencia el nombre antiguo del repo (Pantalla_Restaurante) — API calls sin redirect y metadatos del .deb quedarían rotos`)
  }
}
ok(`tooling de release sin el nombre antiguo (${RELEASE_TOOLING.filter((f) => existsSync(f)).length} archivos)`)

// ---------------------------------------------------------------------------
// 3. Enlaces relativos del README → archivos existentes
// ---------------------------------------------------------------------------
const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const anchors = new Set<string>()
const fileLinks: string[] = []
for (const m of readme.matchAll(linkRe)) {
  const target = m[1]
  if (/^(https?:|mailto:|#)/.test(target)) continue
  if (target.startsWith("#")) continue
  if (target.startsWith("#")) anchors.add(target)
  fileLinks.push(target)
}
for (const link of fileLinks) {
  const clean = link.split("#")[0]
  if (clean === "") {
    anchors.add(link)
    continue
  }
  if (!existsSync(clean)) {
    fail(`el README enlaza '${link}' y esa ruta NO existe`)
  }
}
ok(`${fileLinks.length} enlaces relativos del README existen`)

// ---------------------------------------------------------------------------
// 4. Screenshots referenciados existen (mensaje claro y propio)
// ---------------------------------------------------------------------------
const shots = [...readme.matchAll(/src="(docs\/screenshots\/[^"]+)"/g)].map((m) => m[1])
if (shots.length === 0) fail("el README no muestra capturas de pantalla")
for (const s of new Set(shots)) {
  if (!existsSync(s)) fail(`screenshot del README NO existe: ${s}`)
}
ok(`${new Set(shots).size} screenshots del README existen`)

// ---------------------------------------------------------------------------
// 5. Índice de docs completo: cada docs/*.md de primer nivel enlazado
// ---------------------------------------------------------------------------
const docsDir = "docs"
const allDocs = readdirSync(docsDir).filter(
  (f) => f.endsWith(".md") && statSync(join(docsDir, f)).isFile(),
)
const orphan: string[] = []
for (const d of allDocs) {
  if (!readme.includes(`docs/${d}`)) orphan.push(d)
}
if (orphan.length > 0) {
  fail(`docs NO enlazados desde el README: ${orphan.join(", ")}`)
}
ok(`índice de docs completo (${allDocs.length} guías enlazadas)`)

// ---------------------------------------------------------------------------
// 6. Conteos E2E del README == realidad de e2e/
// ---------------------------------------------------------------------------
const e2eDir = "e2e"
const specFiles = readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts"))
let e2eTests = 0
let e2eScenarios = 0
for (const f of specFiles) {
  const text = readFileSync(join(e2eDir, f), "utf8")
  e2eTests += (text.match(/^\s*test\(/gm) ?? []).length
  e2eScenarios += (text.match(/^\s*test\.describe\(/gm) ?? []).length
}
const specClaim = Number(readme.match(/(\d+)\s*specs?/)?.[1] ?? 0)
const e2eTestClaim = Number(readme.match(/(\d+)\s*tests?\s*\/\s*\d+\s*escenarios/)?.[1] ?? 0)
const scenClaim = Number(readme.match(/\d+\s*tests?\s*\/\s*(\d+)\s*escenarios/)?.[1] ?? 0)
if (specClaim !== specFiles.length) {
  fail(`README dice "${specClaim} specs" pero e2e/ tiene ${specFiles.length} archivos .spec.ts`)
}
if (e2eTestClaim !== e2eTests) {
  fail(`README dice "${e2eTestClaim} tests" E2E pero e2e/ declara ${e2eTests} test()`)
}
if (scenClaim !== e2eScenarios) {
  fail(`README dice "${scenClaim} escenarios" E2E pero e2e/ declara ${e2eScenarios} test.describe()`)
}
ok(`conteos E2E fieles: ${specFiles.length} specs · ${e2eTests} tests · ${e2eScenarios} escenarios`)

// ---------------------------------------------------------------------------
// 7. Conteo de tests unitarios del README en banda con tests/
// (el conteo estático es el suelo — bun test añade expansiones .each)
// ---------------------------------------------------------------------------
const testsDir = "tests"
const walkTests = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const full = join(dir, f)
    if (statSync(full).isDirectory()) return walkTests(full)
    return f.endsWith(".ts") ? [full] : []
  })
let staticTests = 0
for (const f of walkTests(testsDir)) {
  const text = readFileSync(f, "utf8")
  staticTests += (text.match(/^\s*(?:test|it)\(/gm) ?? []).length
}
const unitClaim = Number(readme.match(/bun test\s*#\s*(\d+)\s*tests?/)?.[1] ?? 0)
if (unitClaim === 0) fail("el README no documenta cuántos tests corre `bun test`")
if (unitClaim < staticTests) {
  fail(`README dice "${unitClaim} tests" pero tests/ declara ${staticTests} test()/it() — actualiza el README`)
}
const ceiling = Math.ceil(staticTests * 1.15)
if (unitClaim > ceiling) {
  fail(`README dice "${unitClaim} tests" pero tests/ solo declara ${staticTests} (${unitClaim} > techo ${ceiling}) — ¿inflado?`)
}
ok(`conteo de tests en banda: README ${unitClaim} · estático ${staticTests} · techo ${ceiling}`)

console.log("\nOK — documentación coherente con el repositorio")
